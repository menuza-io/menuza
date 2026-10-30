import {
	inclusiveTaxCents,
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

export type LoyaltyTotalsInput = {
	/** Taxable amount per line, keyed by its cart line id. */
	lines: readonly { lineId: string; taxableCents: number }[]
	subtotalCents: number
	taxInclusive: boolean
	taxRatePercent: number
	tipCents: number
	deliveryFeeCents: number
}

export type LoyaltyDiscountedTotals = {
	loyaltyDiscountCents: number
	taxCents: number
	totalCents: number
}

/**
 * Recomputes tax and total after a loyalty discount. Per line,
 * `taxableAfter = max(0, taxable - allocated)`; the tax runs on the sum at
 * the same rate, inclusive or exclusive like the original pricing. The
 * discount never exceeds the subtotal. An allocation line the cart does not
 * have means the cart changed since the quote: `cart_changed`.
 */
export function discountedTotals(
	input: LoyaltyTotalsInput,
	allocation: readonly { lineId: string; discountMinor: number }[],
	discountMinor: number,
): LoyaltyDiscountedTotals {
	const taxableByLineId = new Map<string, number>()
	for (const line of input.lines) {
		taxableByLineId.set(line.lineId, Math.max(0, line.taxableCents))
	}
	for (const entry of allocation) {
		const taxable = taxableByLineId.get(entry.lineId)
		if (taxable === undefined) throw new LoyaltyDomainError('cart_changed')
		taxableByLineId.set(
			entry.lineId,
			Math.max(0, taxable - Math.max(0, entry.discountMinor)),
		)
	}
	const discount = Math.min(Math.max(0, discountMinor), input.subtotalCents)
	const taxableAfterTotal = [...taxableByLineId.values()].reduce(
		(sum, value) => sum + value,
		0,
	)
	const taxCents = input.taxInclusive
		? inclusiveTaxCents(taxableAfterTotal, input.taxRatePercent)
		: Math.round((taxableAfterTotal * input.taxRatePercent) / 100)
	const totalCents =
		input.subtotalCents -
		discount +
		(input.taxInclusive ? 0 : taxCents) +
		input.tipCents +
		input.deliveryFeeCents
	return { loyaltyDiscountCents: discount, taxCents, totalCents }
}

/**
 * A priced restaurant order with the reward applied: discounted tax and
 * total; subtotal, tip and delivery fee stay as priced.
 */
export function applyLoyaltyDiscountToTotals(
	priced: PricedRestaurantOrder,
	allocation: readonly { lineId: string; discountMinor: number }[],
	discountMinor: number,
): LoyaltyDiscountedTotals {
	return discountedTotals(
		{
			lines: priced.lines.map((line, index) => ({
				lineId: restaurantLineId(index),
				taxableCents: line.taxableCents,
			})),
			subtotalCents: priced.subtotalCents,
			taxInclusive: priced.taxInclusive,
			taxRatePercent: priced.taxRatePercent,
			tipCents: priced.tipCents,
			deliveryFeeCents: priced.deliveryFeeCents,
		},
		allocation,
		discountMinor,
	)
}

/** The neutral loyalty cart of a priced restaurant order. */
export function loyaltyCartForPricedOrder(
	priced: PricedRestaurantOrder,
): LoyaltyCart {
	return {
		currency: priced.currency,
		lines: restaurantCartLines(priced.lines),
		otherDiscountMinor: 0,
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
 * shrinks in proportion to what the reward took off its taxable base (a
 * discount on an untaxed line lowers no tax). Deterministic, so the pay
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
			taxableAfter += Math.max(0, taxable - off)
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
