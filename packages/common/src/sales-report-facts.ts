/**
 * The sale rules every sales reader shares: the items-sold reader
 * (`apps/tenant-api/src/services/item-sales.ts`), the sales, refunds and
 * cancelled-orders report subjects (`sales-report-records.ts`) and, through
 * `POS_SALE_STATUSES`, the till's day report (`pos-reports.ts`). Pure, no
 * dependencies beyond the order lifecycle vocabulary, no customer data.
 *
 * What counts as a sale
 * - A web or QR order counts when it is open or completed and payable (the
 *   `countsTowardSales` rule in tenant-api).
 * - A Station sale counts when it is paid or refunded.
 * - The rounds of a QR tab rung up on a Station till are that till sale.
 *
 * Money
 * - Net sales are items and fees after discounts and loyalty rewards, without
 *   tax and tips. Gross sales are the same before discounts and rewards.
 *   Refunds lower net sales on the day the money went back.
 * - Everything here is in minor units and never crosses a currency.
 */

import {
	ORDER_CANCELLED_BY_VALUES,
	ORDER_STORED_CANCEL_REASONS,
} from './order-lifecycle.ts'

/** Station sale statuses that count as a sale. */
export const POS_SALE_STATUSES = ['paid', 'refunded'] as const

export const SALES_BASIS_VALUES = ['gross', 'net'] as const
export type SalesBasis = (typeof SALES_BASIS_VALUES)[number]

export function posOrderCountsAsSale(status: string) {
	return (POS_SALE_STATUSES as readonly string[]).includes(status)
}

export const SALES_CHANNELS = [
	'online_menu',
	'drop',
	'qr_table',
	'qr_poster',
	'station_counter',
	'station_phone',
] as const
export type SalesChannel = (typeof SALES_CHANNELS)[number]

export const SALES_TENDERS = [
	'card_online',
	'cash',
	'card_till',
	'gift_card',
	'other',
	'handoff',
	'none',
] as const
export type SalesTender = (typeof SALES_TENDERS)[number]

export const ORDER_CANCEL_GROUPS = [
	'expired_unpaid',
	'rejected_by_restaurant',
	'cancelled_by_guest',
	'cancelled_by_staff',
	'voided_at_till',
] as const
export type OrderCancelGroup = (typeof ORDER_CANCEL_GROUPS)[number]

/** The channel of a web or QR order. A drop order is a drop wherever it came from. */
export function restaurantSalesChannel(order: {
	source: string | null
	dropId: string | null
}): SalesChannel {
	if (order.dropId) return 'drop'
	if (order.source === 'qr_table') return 'qr_table'
	if (order.source === 'qr_poster') return 'qr_poster'
	return 'online_menu'
}

export function posSalesChannel(orderSource: string | null): SalesChannel {
	return orderSource === 'phone' ? 'station_phone' : 'station_counter'
}

/** The tender of a till payment or refund. */
export function posTender(method: string): SalesTender {
	if (method === 'cash') return 'cash'
	if (method === 'card') return 'card_till'
	if (method === 'gift_card') return 'gift_card'
	return 'other'
}

/** The money of one sale, in minor units. `net + tax + tip` is what was paid. */
export type SaleMoney = {
	grossMinor: number
	/** Discounts and coupons, delivery discounts included. Never a loyalty reward. */
	discountMinor: number
	loyaltyMinor: number
	taxMinor: number
	tipMinor: number
	netMinor: number
	/** What the guest paid: tax and tips included. */
	totalMinor: number
}

export function saleAmountMinor(
	sale: Pick<SaleMoney, 'grossMinor' | 'netMinor'>,
	basis: SalesBasis,
): number {
	return basis === 'gross' ? sale.grossMinor : sale.netMinor
}

/**
 * Net item sales of a web or QR order: subtotal less item discounts and the
 * loyalty reward, less tax when prices include it. Orders do not store whether
 * prices included tax; it is read from the totals (`total = net + tip +
 * delivery + service fee`, tax not added, means inclusive).
 */
export function restaurantOrderNetMinor(order: {
	subtotalCents: number
	discountCents: number
	loyaltyDiscountCents: number | null
	taxCents: number
	tipCents: number
	deliveryFeeCents: number
	deliveryDiscountCents: number
	totalCents: number
	/** The guest service fee and its tax (#123); items never include them. */
	serviceFeeCents?: number
	serviceFeeTaxCents?: number
}): number {
	const afterDiscounts =
		order.subtotalCents -
		order.discountCents -
		(order.loyaltyDiscountCents ?? 0)
	const delivery = order.deliveryFeeCents - order.deliveryDiscountCents
	const inclusive =
		order.taxCents > 0 &&
		order.totalCents ===
			afterDiscounts + order.tipCents + delivery + (order.serviceFeeCents ?? 0)
	// The tax on the service fee is not tax on the items.
	const itemTax = order.taxCents - (order.serviceFeeTaxCents ?? 0)
	return Math.max(0, afterDiscounts - (inclusive ? itemTax : 0))
}

/** Net item sales of a Station sale (adjustments hold discounts and rewards). */
export function posOrderNetMinor(order: {
	subtotalCents: number
	adjustmentCents: number
	taxCents: number
	taxInclusive: boolean
}): number {
	return Math.max(
		0,
		order.subtotalCents -
			order.adjustmentCents -
			(order.taxInclusive ? order.taxCents : 0),
	)
}

/**
 * The money of a web or QR order. Fees (delivery after its discount, and the
 * guest service fee) are sales; tax and tips are not.
 */
export function restaurantSaleMoney(order: {
	subtotalCents: number
	discountCents: number
	loyaltyDiscountCents: number | null
	taxCents: number
	tipCents: number
	deliveryFeeCents: number
	deliveryDiscountCents: number
	totalCents: number
	serviceFeeCents?: number
	serviceFeeTaxCents?: number
}): SaleMoney {
	const fees =
		Math.max(0, order.deliveryFeeCents - order.deliveryDiscountCents) +
		(order.serviceFeeCents ?? 0)
	const netMinor = restaurantOrderNetMinor(order) + fees
	const discountMinor = order.discountCents + order.deliveryDiscountCents
	const loyaltyMinor = order.loyaltyDiscountCents ?? 0
	return {
		grossMinor: netMinor + discountMinor + loyaltyMinor,
		discountMinor,
		loyaltyMinor,
		taxMinor: order.taxCents,
		tipMinor: order.tipCents,
		netMinor,
		totalMinor: order.totalCents,
	}
}

/**
 * The money of a Station sale. `adjustmentCents` holds discounts and loyalty
 * rewards together; `adjustments` (the stored list) tells them apart.
 */
export function posSaleMoney(order: {
	subtotalCents: number
	adjustmentCents: number
	taxCents: number
	tipCents: number
	totalCents: number
	taxInclusive: boolean
	adjustments?: unknown
}): SaleMoney {
	const netMinor = posOrderNetMinor(order)
	const taken = Math.max(0, order.adjustmentCents)
	let loyalty = 0
	if (Array.isArray(order.adjustments)) {
		for (const entry of order.adjustments) {
			if (!entry || typeof entry !== 'object') continue
			const adjustment = entry as { kind?: unknown; amountCents?: unknown }
			if (
				adjustment.kind === 'loyalty' &&
				typeof adjustment.amountCents === 'number' &&
				Number.isFinite(adjustment.amountCents)
			) {
				loyalty += Math.max(0, Math.trunc(adjustment.amountCents))
			}
		}
	}
	// The list can add up to more than the sale; the total actually taken wins.
	const loyaltyMinor = Math.min(loyalty, taken)
	return {
		grossMinor: netMinor + taken,
		discountMinor: taken - loyaltyMinor,
		loyaltyMinor,
		taxMinor: order.taxCents,
		tipMinor: order.tipCents,
		netMinor,
		totalMinor: order.totalCents,
	}
}

/**
 * `total` split in proportion to `weights` with a largest-remainder rule, so
 * the shares are whole minor units and add up to `total` exactly. With no
 * weight at all, the first share takes everything.
 */
export function splitMinor(
	total: number,
	weights: readonly number[],
): number[] {
	if (weights.length === 0) return []
	const amount = Math.trunc(total)
	const positive = weights.map((weight) =>
		Number.isFinite(weight) && weight > 0 ? weight : 0,
	)
	const sum = positive.reduce((left, right) => left + right, 0)
	if (sum === 0)
		return positive.map((_unused, index) => (index === 0 ? amount : 0))
	const sign = amount < 0 ? -1 : 1
	const size = Math.abs(amount)
	const exact = positive.map((weight) => (size * weight) / sum)
	const shares = exact.map((value) => Math.floor(value))
	let left = size - shares.reduce((a, b) => a + b, 0)
	const order = exact
		.map((value, index) => ({ index, rest: value - Math.floor(value) }))
		.sort((a, b) => b.rest - a.rest || a.index - b.index)
	for (const { index } of order) {
		if (left <= 0) break
		shares[index] = (shares[index] ?? 0) + 1
		left -= 1
	}
	return shares.map((share) => share * sign)
}

/**
 * What a refund of `amountMinor` takes back from net sales, tax and tips: the
 * same proportions as the sale it is against. The three parts add up to the
 * refund exactly. A sale with nothing to split puts it all against net sales.
 */
export function refundShares(
	amountMinor: number,
	sale: Pick<SaleMoney, 'netMinor' | 'taxMinor' | 'tipMinor'>,
): { netMinor: number; taxMinor: number; tipMinor: number } {
	const [netMinor = 0, taxMinor = 0, tipMinor = 0] = splitMinor(amountMinor, [
		sale.netMinor,
		sale.taxMinor,
		sale.tipMinor,
	])
	return { netMinor, taxMinor, tipMinor }
}

function known<T extends string>(
	values: readonly T[],
	value: unknown,
): T | null {
	return typeof value === 'string' &&
		(values as readonly string[]).includes(value)
		? (value as T)
		: null
}

/**
 * Why a web or QR order never counted, from the columns it already has:
 * - `expired`: the guest never paid (the hold ran out).
 * - a `rejected_reason`: the restaurant turned it down, or did not accept it
 *   in time.
 * - `cancelled_by = guest`: the guest cancelled.
 * - anything else cancelled: staff did (orders from before `cancelled_by`
 *   existed were only ever cancelled by staff).
 * Returns null for an order that is not cancelled or expired.
 */
export function orderCancelGroup(order: {
	status: string
	cancelReason: string | null
	cancelledBy: string | null
	rejectedReason: string | null
}): { group: OrderCancelGroup; reason: string } | null {
	if (order.status === 'expired') {
		return { group: 'expired_unpaid', reason: 'payment_expired' }
	}
	if (order.status !== 'cancelled') return null
	const rejected = known(ORDER_STORED_CANCEL_REASONS, order.rejectedReason)
	const reason = known(ORDER_STORED_CANCEL_REASONS, order.cancelReason)
	if (rejected || reason === 'not_accepted_in_time') {
		return {
			group: 'rejected_by_restaurant',
			reason: rejected ?? 'not_accepted_in_time',
		}
	}
	const by = known(ORDER_CANCELLED_BY_VALUES, order.cancelledBy)
	return {
		group: by === 'guest' ? 'cancelled_by_guest' : 'cancelled_by_staff',
		reason: reason ?? 'none',
	}
}
