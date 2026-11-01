import {
	applyOrderDiscounts,
	type PricedOrderLine,
	type PricedRestaurantOrder,
} from '@repo/common/restaurant-orders'
import { LoyaltyDomainError, type LoyaltyCart } from '@repo/loyalty'
import { type RestaurantOrder } from '@repo/tenant-db'
import { QR_ROUND_VOID_STATUSES } from '../services/qr-dine-in.ts'
import {
	expandTabAllocation,
	restaurantCartLines,
	restaurantLineId,
} from './loyalty-sources.ts'

/**
 * Loyalty at checkout: how a reward's discount moves an order's totals. Pure
 * helpers — no I/O — shared by placement, the tab payment freeze and the
 * checkout quote endpoint. The discount lowers the taxable base line by line
 * (a discount on a non-taxable line never lowers the tax), then the total
 * follows the same rule the pricing engine used.
 */

export type LoyaltyDiscountedTotals = {
	loyaltyDiscountCents: number
	taxCents: number
	totalCents: number
}

/** Discounts and coupons applied before the reward (the engine's output). */
export type OtherOrderDiscounts = {
	/** Total discount per line id. */
	lineDiscounts?: Readonly<Record<string, number>>
	deliveryDiscountMinor?: number
}

/**
 * Recomputes tax and total after a loyalty reward, on top of any discounts
 * and coupons, through the one shared rule `applyOrderDiscounts`: a line's
 * discount comes off its taxed and untaxed parts in proportion
 * (`taxableAfter = max(0, taxable - round(off * taxable / total))`, so a
 * discount on an untaxed line never lowers the tax), the tax runs on the sum at
 * the same rate (inclusive or exclusive, like the original pricing), and the tip
 * stays on the pre-discount subtotal. The reward never exceeds the subtotal.
 * An allocation line the cart does not have means the cart changed since the
 * quote: `cart_changed`.
 */
export function applyLoyaltyDiscountToTotals(
	priced: PricedRestaurantOrder,
	allocation: readonly { lineId: string; discountMinor: number }[],
	discountMinor: number,
	others: OtherOrderDiscounts = {},
): LoyaltyDiscountedTotals {
	const known = new Set(priced.lines.map((_, index) => restaurantLineId(index)))
	const lineDiscounts: Record<string, number> = { ...others.lineDiscounts }
	for (const entry of allocation) {
		if (!known.has(entry.lineId)) throw new LoyaltyDomainError('cart_changed')
		lineDiscounts[entry.lineId] =
			(lineDiscounts[entry.lineId] ?? 0) + Math.max(0, entry.discountMinor)
	}
	const totals = applyOrderDiscounts(
		priced,
		lineDiscounts,
		others.deliveryDiscountMinor ?? 0,
	)
	return {
		loyaltyDiscountCents: Math.min(
			Math.max(0, discountMinor),
			priced.subtotalCents,
		),
		taxCents: totals.taxCents,
		totalCents: totals.totalCents,
	}
}

/** The neutral loyalty cart of a priced restaurant order. */
export function loyaltyCartForPricedOrder(
	priced: PricedRestaurantOrder,
	lineDiscounts: Readonly<Record<string, number>> = {},
): LoyaltyCart {
	return {
		currency: priced.currency,
		lines: restaurantCartLines(priced.lines, undefined, lineDiscounts),
	}
}

export type DiscountedTabTotals = {
	loyaltyDiscountCents: number
	/** As the rounds were priced: the reward never changes the subtotal. */
	subtotalCents: number
	taxCents: number
	/** Before the tip. */
	totalCents: number
}

/**
 * A tab's totals with its reward applied, from the stored rounds alone.
 * Rounds keep the tax they were priced with and no rate, so each round's tax
 * shrinks in proportion to what the reward took off its taxable base. Like
 * `applyOrderDiscounts` (web and till) a line's discount comes off its taxed
 * and untaxed parts in proportion, so a discount on an untaxed line lowers no
 * tax and one on a part-taxed line lowers it by the taxed share only. Deterministic, so the pay
 * request, every payment bridge step and settlement agree to the cent. Null
 * when the allocation names a line the tab no longer has: the cart changed.
 */
export function discountedTabTotals(
	rounds: readonly RestaurantOrder[],
	allocation: readonly { lineId: string; discountMinor: number }[],
): DiscountedTabTotals | null {
	const pending = new Map<string, number>()
	for (const entry of expandTabAllocation(rounds, allocation)) {
		pending.set(
			entry.lineId,
			(pending.get(entry.lineId) ?? 0) + Math.max(0, entry.discountMinor),
		)
	}
	const totals: DiscountedTabTotals = {
		loyaltyDiscountCents: 0,
		subtotalCents: 0,
		taxCents: 0,
		totalCents: 0,
	}
	for (const round of rounds) {
		if ((QR_ROUND_VOID_STATUSES as readonly string[]).includes(round.status)) {
			continue
		}
		const lines = Array.isArray(round.lines)
			? (round.lines as PricedOrderLine[])
			: []
		let taxableBefore = 0
		let taxableAfter = 0
		let roundDiscount = 0
		lines.forEach((line, index) => {
			const lineId = restaurantLineId(index, round.id)
			const taxable = Math.max(0, line.taxableCents)
			const off = Math.min(
				pending.get(lineId) ?? 0,
				Math.max(0, line.totalCents),
			)
			pending.delete(lineId)
			taxableBefore += taxable
			// The same rule as `applyOrderDiscounts` (web and till): the discount
			// comes off the taxed and untaxed parts of the line in proportion.
			const share = line.totalCents > 0 ? taxable / line.totalCents : 0
			taxableAfter += Math.max(0, taxable - Math.round(off * share))
			roundDiscount += off
		})
		const taxInclusive =
			round.taxCents > 0 &&
			round.totalCents ===
				round.subtotalCents + round.tipCents + round.deliveryFeeCents
		const taxCents =
			taxableBefore > 0
				? Math.round((round.taxCents * taxableAfter) / taxableBefore)
				: round.taxCents
		totals.loyaltyDiscountCents += roundDiscount
		totals.subtotalCents += round.subtotalCents
		totals.taxCents += taxCents
		totals.totalCents +=
			round.totalCents -
			roundDiscount -
			(taxInclusive ? 0 : round.taxCents - taxCents)
	}
	return pending.size > 0 ? null : totals
}
