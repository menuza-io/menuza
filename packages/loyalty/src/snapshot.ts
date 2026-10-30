import {
	LOYALTY_MAX_PURCHASE_LINE_QUANTITY,
	LOYALTY_MAX_PURCHASE_LINES,
	loyaltyPurchaseSnapshotSchema,
	type LoyaltyPurchaseLine,
	type LoyaltyPurchaseSnapshot,
} from './earning.ts'
import {
	allocateProportionally,
	LOYALTY_MAX_MINOR,
	mulDiv,
	normalizeCurrency,
	sumMinor,
} from './money.ts'

/**
 * Turns a channel's priced lines into the purchase snapshot earning and refunds
 * read. Each line's `netMinor` is its merchandise after the loyalty discount
 * and any other sale discount, without tax: inclusive tax is taken out of the
 * line by its share of the sale's tax, exclusive tax was never in it. Shares
 * are largest-remainder splits, so the same sale always gives the same lines.
 */

export type SnapshotSourceLine = {
	lineId: string
	itemId: string
	categoryIds: readonly string[]
	quantity: number
	/** The line before discounts, modifiers included, in the subtotal's units. */
	grossMinor: number
	/** The taxable part of `grossMinor`. */
	taxableMinor: number
}

export type SnapshotAllocationLine = {
	lineId: string
	discountMinor: number
	rewardUnits: number
}

const CATALOG_ID_PATTERN = /^[A-Za-z0-9_:.-]+$/
const MAX_CATEGORY_IDS = 50
const MAX_QUANTITY = 1000

/** Catalog ids as the snapshot schema accepts them; anything else is rewritten, never dropped. */
export function snapshotCatalogId(id: string): string {
	const trimmed = id.slice(0, 100)
	if (trimmed.length > 0 && CATALOG_ID_PATTERN.test(trimmed)) return trimmed
	const cleaned = trimmed.replace(/[^A-Za-z0-9_:.-]/g, '_')
	return cleaned.length > 0 ? cleaned : 'unknown'
}

function nonNegative(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Lines of the same item and categories add up into one, so a purchase made of
 * many rounds (a QR tab) stays within the snapshot bound. Units, reward units
 * and merchandise add; every earning rule and refund split reads only those
 * sums. Lines that carry value never merge with lines that carry none (a free
 * item), because a line with no value earns no units. The first line's id
 * stands for the group. Only runs when the purchase would not otherwise fit.
 */
function mergeLinesOfSameItem(
	lines: readonly LoyaltyPurchaseLine[],
): LoyaltyPurchaseLine[] {
	if (lines.length <= LOYALTY_MAX_PURCHASE_LINES) return [...lines]
	const merged = new Map<string, LoyaltyPurchaseLine>()
	for (const line of lines) {
		const key = JSON.stringify([
			line.itemId,
			[...line.categoryIds].sort(),
			line.netMinor > 0,
		])
		const known = merged.get(key)
		if (!known) {
			merged.set(key, { ...line, categoryIds: [...line.categoryIds] })
			continue
		}
		known.quantity = Math.min(
			known.quantity + line.quantity,
			LOYALTY_MAX_PURCHASE_LINE_QUANTITY,
		)
		known.rewardUnits = Math.min(
			known.rewardUnits + line.rewardUnits,
			known.quantity,
		)
		known.netMinor = Math.min(known.netMinor + line.netMinor, LOYALTY_MAX_MINOR)
	}
	return [...merged.values()]
}

export function buildPurchaseSnapshot(input: {
	currency: string
	/** Everything the customer paid: merchandise after discounts, tax, tip and fees. */
	totalPaidMinor: number
	/** Tax the sale charged after its discounts. */
	taxMinor: number
	taxInclusive: boolean
	lines: readonly SnapshotSourceLine[]
	/** How the loyalty discount splits over the lines. */
	allocation?: readonly SnapshotAllocationLine[]
	/** A sale-level discount that is not split over lines (a till discount). */
	otherDiscountMinor?: number
}): LoyaltyPurchaseSnapshot {
	const allocation = new Map<string, SnapshotAllocationLine>()
	for (const line of input.allocation ?? []) allocation.set(line.lineId, line)

	const lines = input.lines.map((line) => {
		const quantity = Math.min(
			Math.max(1, Math.floor(line.quantity)),
			MAX_QUANTITY,
		)
		const gross = nonNegative(line.grossMinor)
		const taxable = Math.min(gross, nonNegative(line.taxableMinor))
		const share = allocation.get(line.lineId)
		const loyaltyDiscount = Math.min(
			gross,
			nonNegative(share?.discountMinor ?? 0),
		)
		const rewardUnits = Math.min(quantity, nonNegative(share?.rewardUnits ?? 0))
		const categoryIds = [
			...new Set(line.categoryIds.map(snapshotCatalogId)),
		].slice(0, MAX_CATEGORY_IDS)
		return {
			lineId: line.lineId,
			itemId: snapshotCatalogId(line.itemId),
			categoryIds,
			quantity,
			gross,
			taxable,
			afterLoyalty: gross - loyaltyDiscount,
			rewardUnits,
		}
	})

	const afterLoyalty = lines.map((line) => line.afterLoyalty)
	const other = Math.min(
		nonNegative(input.otherDiscountMinor ?? 0),
		sumMinor(afterLoyalty),
	)
	const otherShares =
		lines.length > 0 ? allocateProportionally(other, afterLoyalty) : []
	const after = lines.map(
		(line, index) => line.afterLoyalty - otherShares[index]!,
	)

	let taxShares = lines.map(() => 0)
	const tax = nonNegative(input.taxMinor)
	if (input.taxInclusive && tax > 0 && lines.length > 0) {
		// The taxable part of what is left of each line after its discounts.
		let weights = lines.map((line, index) =>
			line.gross > 0 ? mulDiv(line.taxable, after[index]!, line.gross) : 0,
		)
		if (sumMinor(weights) === 0) weights = after
		const total = Math.min(tax, sumMinor(weights))
		taxShares = allocateProportionally(total, weights)
	}

	return loyaltyPurchaseSnapshotSchema.parse({
		currency: normalizeCurrency(input.currency),
		totalPaidMinor: nonNegative(input.totalPaidMinor),
		lines: mergeLinesOfSameItem(
			lines.map((line, index) => ({
				lineId: line.lineId,
				itemId: line.itemId,
				categoryIds: line.categoryIds,
				quantity: line.quantity,
				netMinor: Math.max(0, after[index]! - taxShares[index]!),
				rewardUnits: line.rewardUnits,
			})),
		),
	})
}
