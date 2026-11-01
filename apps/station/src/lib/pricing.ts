/**
 * Local, offline pricing. Follows the same cent arithmetic as the regional
 * engine in `@repo/common/restaurant-orders` (base price always taxable, an
 * option taxable unless `applySalesTax === false`, tax and tip rounded once on
 * the order). The server reprices every synced order and its figures win;
 * these exist so the cashier sees a total with no network.
 */
import {
	discountedTaxableCents,
	sumLineAmounts,
} from '@repo/common/pos-discount-base'

export type CartOption = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	quantity: number
	/** Cents for one unit of this option. */
	unitCents: number
	taxable: boolean
}

export type CartLine = {
	/** Local line id; never sent to the server. */
	id: string
	itemId: string
	name: string
	variantId: string | null
	variantLabel: string | null
	quantity: number
	baseCents: number
	instructions: string
	options: CartOption[]
	/**
	 * When this line went to the kitchen (the tab was saved or the sale made).
	 * Absent: not sent yet. Kept on this till only; the upload never carries it.
	 */
	sentAt?: number
	/** When a server marked it brought to the table. This till only, like `sentAt`. */
	servedAt?: number
	/**
	 * How many of it the kitchen has, while a tab is open in the cart: "one
	 * fewer, then one more" puts it back instead of sending it again.
	 */
	sentQuantity?: number
}

/**
 * Reserved for discounts and loyalty. Today nothing creates one, but totals,
 * stored orders and receipts already carry the list so adding a discount later
 * is a new producer, not a schema change. `amountCents` is positive and is
 * subtracted before tax.
 */
export type Adjustment = {
	id: string
	kind: 'discount' | 'loyalty'
	label: string
	amountCents: number
	approvedByStaffId?: string
	reason?: string
	/**
	 * Optional. How much of this discount each line took, keyed by the local line
	 * id. With it the taxable amount shrinks line by line, as it does online
	 * (`applyOrderDiscounts` in `@repo/common/restaurant-orders`); without it
	 * (a loyalty reward, or a sale loaded from another terminal) the discount
	 * shrinks the whole taxable base in proportion. It is uploaded under the
	 * same name, so the region can allocate the discount to loyalty line by line.
	 */
	lineAmounts?: Record<string, number>
	/** The version of the rule a discount came from, so the region can tell when it is out of date. */
	version?: number
}

export type Totals = {
	subtotalCents: number
	adjustmentCents: number
	taxCents: number
	tipCents: number
	totalCents: number
}

export const lineUnitCents = (line: CartLine): number =>
	line.baseCents +
	line.options.reduce((sum, o) => sum + o.unitCents * o.quantity, 0)

export const lineTotalCents = (line: CartLine): number =>
	lineUnitCents(line) * line.quantity

const lineTaxableCents = (line: CartLine): number =>
	(line.baseCents +
		line.options.reduce(
			(sum, o) => sum + (o.taxable ? o.unitCents * o.quantity : 0),
			0,
		)) *
	line.quantity

export function computeTotals(input: {
	lines: CartLine[]
	taxRatePercent: number
	/** Prices already include the tax: it is shown, not added. */
	taxInclusive?: boolean
	tipPercent?: number
	tipCents?: number
	adjustments?: Adjustment[]
}): Totals {
	const subtotalCents = input.lines.reduce((s, l) => s + lineTotalCents(l), 0)
	const adjustments = input.adjustments ?? []
	const adjustmentCents = Math.min(
		subtotalCents,
		adjustments.reduce((s, a) => s + a.amountCents, 0),
	)
	// A discount that says which line took what shrinks that line's taxable
	// amount, the way the server does it online: taxed and untaxed parts of a line
	// lose the discount in proportion, and a discount on a line with nothing
	// taxable never lowers the tax. Discounts without line amounts (a loyalty
	// reward, a sale loaded from another terminal) shrink what is left in
	// proportion to the whole bill.
	// The shared calculation (`@repo/common/pos-discount-base`) is also what the
	// ZATCA invoice uses, so its VAT is this VAT.
	const perLine = sumLineAmounts(adjustments)
	const { taxableAfterCents: taxBase } = discountedTaxableCents({
		lines: input.lines.map((line) => ({
			totalCents: lineTotalCents(line),
			taxableCents: lineTaxableCents(line),
			offCents: perLine.get(line.id),
		})),
		adjustmentCents,
	})
	const rate = Math.max(0, Math.min(100, input.taxRatePercent || 0))
	const inclusive = input.taxInclusive === true
	// Inclusive: the part of the price that is tax, as the engine computes it.
	const taxCents = inclusive
		? Math.round((taxBase * rate) / (100 + rate))
		: Math.round((taxBase * rate) / 100)
	// A tip is a percentage of the subtotal before discounts.
	const tipCents =
		input.tipCents ??
		Math.round((subtotalCents * (input.tipPercent ?? 0)) / 100)
	return {
		subtotalCents,
		adjustmentCents,
		taxCents,
		tipCents,
		totalCents:
			subtotalCents - adjustmentCents + (inclusive ? 0 : taxCents) + tipCents,
	}
}

/** Lines that are identical (same item, variant, options, note) merge. */
export const lineSignature = (
	line: Omit<CartLine, 'id' | 'quantity'>,
): string =>
	JSON.stringify([
		line.itemId,
		line.variantId,
		line.instructions.trim(),
		line.options
			.map((o) => [o.groupId, o.optionId, o.quantity])
			.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
	])
