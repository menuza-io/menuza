/**
 * Sales summary for the walk-in point of sale: one calculation for the till's
 * printed shift report (Z report) and the server's shift and day reports, so
 * the two never disagree about what a figure means. No dependencies.
 *
 * Orders say what was sold (counts, tax, tips, cancellations, items taken
 * off); payments and refunds say what money moved, and are passed separately
 * because a tab rung up in one shift may be paid in the next.
 */

export type PosTender = 'cash' | 'card' | 'other'

export type PosSummaryOrder = {
	status: 'open' | 'paid' | 'void' | 'refunded'
	totals: { taxCents: number; tipCents: number; totalCents: number }
	/**
	 * Optional. What the sale's items came to before any discount or loyalty
	 * reward, at menu prices (tax and tip excluded; a tax-inclusive menu's
	 * prices already hold their tax): the sale's `totals.subtotalCents`.
	 * Without it, or without `discountCents`, the summary leaves its discount
	 * figures out rather than report a false zero.
	 */
	subtotalCents?: number
	/**
	 * Optional. What the sale's discounts took off: its `discount` adjustments
	 * only, never a loyalty reward (that is `loyaltyDiscountCents`).
	 */
	discountCents?: number
	/** Optional. What a loyalty reward took off (its `loyalty` adjustments); missing reads as 0. */
	loyaltyDiscountCents?: number
	lineVoids: Array<{ quantity: number; unitCents: number }>
}

export type PosSummaryMoney = { method: PosTender; amountCents: number }
export type PosSummaryRefund = PosSummaryMoney & { taxCents: number }
export type PosSummaryMovement = {
	kind: 'pay_in' | 'pay_out'
	amountCents: number
}

export type PosTenderTotals = {
	paymentsCents: number
	refundsCents: number
	netCents: number
}

export type PosSalesSummary = {
	orders: { paid: number; refunded: number; cancelled: number; open: number }
	/**
	 * Closed sales at their full value, tax and tips included. Discounts are
	 * already off it: it is not a figure before discounts (see
	 * `grossBeforeDiscountsCents`).
	 */
	grossSalesCents: number
	/**
	 * Optional (left out when a closed sale did not say). What the items of
	 * closed sales came to before any discount or loyalty reward: the sum of
	 * their `subtotalCents`, tax and tips excluded. Not `grossSalesCents` plus
	 * discounts: that would hold tax and tips.
	 */
	grossBeforeDiscountsCents?: number
	/**
	 * Optional, like `grossBeforeDiscountsCents`: what discounts (automatic,
	 * manual and coupons) took off closed sales. Loyalty rewards are not in it.
	 */
	discountCents?: number
	/** Optional, like `grossBeforeDiscountsCents`: what loyalty rewards took off closed sales. */
	loyaltyDiscountCents?: number
	refundsCents: number
	/** Gross sales less refunds. */
	netSalesCents: number
	/** Tax on closed sales, less the tax share of refunds. */
	taxCents: number
	tipsCents: number
	byTender: Record<PosTender, PosTenderTotals>
	voids: {
		cancelledOrders: number
		cancelledCents: number
		/** Items taken off saved tabs: how many, and what they were worth. */
		removedItems: number
		removedCents: number
	}
	cash: {
		openingFloatCents: number
		paymentsCents: number
		refundsCents: number
		payInsCents: number
		payOutsCents: number
		/** What should be in the drawer: float + cash taken - cash refunded + pay-ins - pay-outs. */
		expectedCents: number
	}
}

const TENDERS: PosTender[] = ['cash', 'card', 'other']

export function posSalesSummary(input: {
	orders: PosSummaryOrder[]
	payments: PosSummaryMoney[]
	refunds: PosSummaryRefund[]
	openingFloatCents?: number
	movements?: PosSummaryMovement[]
}): PosSalesSummary {
	const byTender = Object.fromEntries(
		TENDERS.map((t) => [t, { paymentsCents: 0, refundsCents: 0, netCents: 0 }]),
	) as Record<PosTender, PosTenderTotals>
	for (const p of input.payments)
		byTender[p.method].paymentsCents += p.amountCents
	for (const r of input.refunds)
		byTender[r.method].refundsCents += r.amountCents
	for (const t of TENDERS)
		byTender[t].netCents = byTender[t].paymentsCents - byTender[t].refundsCents

	const orders = { paid: 0, refunded: 0, cancelled: 0, open: 0 }
	let grossSalesCents = 0
	let grossBeforeDiscountsCents = 0
	let discountCents = 0
	let loyaltyDiscountCents = 0
	let discountsKnown = true
	let taxCents = 0
	let tipsCents = 0
	const voids = {
		cancelledOrders: 0,
		cancelledCents: 0,
		removedItems: 0,
		removedCents: 0,
	}
	for (const order of input.orders) {
		if (order.status === 'void') {
			orders.cancelled++
			voids.cancelledOrders++
			voids.cancelledCents += order.totals.totalCents
		} else if (order.status === 'open') {
			orders.open++
		} else {
			if (order.status === 'paid') orders.paid++
			else orders.refunded++
			grossSalesCents += order.totals.totalCents
			if (
				Number.isFinite(order.subtotalCents) &&
				Number.isFinite(order.discountCents)
			) {
				grossBeforeDiscountsCents += order.subtotalCents!
				discountCents += order.discountCents!
				const loyalty = order.loyaltyDiscountCents ?? 0
				if (Number.isFinite(loyalty)) loyaltyDiscountCents += loyalty
			} else discountsKnown = false
			taxCents += order.totals.taxCents
			tipsCents += order.totals.tipCents
		}
		for (const v of order.lineVoids) {
			voids.removedItems += v.quantity
			voids.removedCents += v.quantity * v.unitCents
		}
	}
	const refundsCents = input.refunds.reduce((s, r) => s + r.amountCents, 0)
	taxCents -= input.refunds.reduce((s, r) => s + r.taxCents, 0)

	const movements = input.movements ?? []
	const payInsCents = movements
		.filter((m) => m.kind === 'pay_in')
		.reduce((s, m) => s + m.amountCents, 0)
	const payOutsCents = movements
		.filter((m) => m.kind === 'pay_out')
		.reduce((s, m) => s + m.amountCents, 0)
	const openingFloatCents = input.openingFloatCents ?? 0
	return {
		orders,
		grossSalesCents,
		...(discountsKnown
			? { grossBeforeDiscountsCents, discountCents, loyaltyDiscountCents }
			: {}),
		refundsCents,
		netSalesCents: grossSalesCents - refundsCents,
		taxCents,
		tipsCents,
		byTender,
		voids,
		cash: {
			openingFloatCents,
			paymentsCents: byTender.cash.paymentsCents,
			refundsCents: byTender.cash.refundsCents,
			payInsCents,
			payOutsCents,
			expectedCents:
				openingFloatCents +
				byTender.cash.paymentsCents -
				byTender.cash.refundsCents +
				payInsCents -
				payOutsCents,
		},
	}
}
