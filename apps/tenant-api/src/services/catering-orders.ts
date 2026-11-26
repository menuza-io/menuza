import {
	balanceDueAtMs,
	computeDepositSplit,
	type CateringLocationPolicy,
} from '@repo/common/catering'
import { type RestaurantOrder } from '@repo/tenant-db'

/**
 * How a catering order is collected (#361): the order's own payment is the
 * deposit (the whole total when no deposit applies), the balance is paid
 * later through its own link. These helpers are shared by placing an order,
 * paying a quote, the payment event and the refund rules, so there is one
 * place that says what is charged now, what was captured and what is owed.
 */

export type CateringCollectionColumns = {
	isCatering: true
	cateringEventAt: Date
	guestCount: number | null
	cateringNotes: string | null
	cateringQuoteId: string | null
	depositPercent: number | null
	depositCents: number
	balanceDueAt: Date | null
	balanceState: 'due' | null
	balanceVersion: number
}

/**
 * The catering columns of a new order: the deposit taken at checkout, the
 * balance that follows and when it falls due. A location without a deposit
 * (or a 100 percent one) takes the whole total up front and owes nothing.
 */
export function cateringCollectionColumns(input: {
	policy: CateringLocationPolicy
	totalCents: number
	eventAt: Date
	timeZone: string
	guestCount: number | null
	notes: string | null
	quoteId?: string | null
	/** A quote's own deposit percent; null follows the location. */
	depositPercentOverride?: number | null
}): CateringCollectionColumns {
	const { policy } = input
	const percent =
		input.depositPercentOverride ?? policy.settings.deposit.percent
	const split = computeDepositSplit({ totalCents: input.totalCents, percent })
	const owes = split.balanceCents > 0
	return {
		isCatering: true,
		cateringEventAt: input.eventAt,
		guestCount: input.guestCount,
		cateringNotes: input.notes,
		cateringQuoteId: input.quoteId ?? null,
		depositPercent: owes ? split.percent : null,
		depositCents: split.depositCents,
		balanceDueAt: owes
			? new Date(
					balanceDueAtMs(
						input.eventAt,
						policy.settings.deposit.balanceDueDaysBeforeEvent,
						input.timeZone,
					),
				)
			: null,
		balanceState: owes ? 'due' : null,
		balanceVersion: 1,
	}
}

type ChargeFields = Pick<
	RestaurantOrder,
	'totalCents' | 'giftCardCents' | 'isCatering' | 'depositCents'
>

/**
 * What the provider is asked for now: the deposit of a catering order, else
 * the total less what a gift card paid. The one rule the order quote and the
 * payment event share, so a deposit order is checked against the deposit.
 */
export function orderChargeCents(order: ChargeFields): number {
	if (order.isCatering && order.depositCents != null) return order.depositCents
	return order.totalCents - order.giftCardCents
}

/** The balance still owed on a confirmed catering order (0 when none, paid or voided). */
export function cateringBalanceOwedCents(
	order: Pick<
		RestaurantOrder,
		| 'isCatering'
		| 'balanceState'
		| 'totalCents'
		| 'depositCents'
		| 'balancePaidCents'
		| 'paymentStatus'
	>,
): number {
	if (!order.isCatering || order.balanceState !== 'due') return 0
	if (order.paymentStatus !== 'paid') return 0
	return Math.max(
		0,
		order.totalCents -
			(order.depositCents ?? order.totalCents) -
			order.balancePaidCents,
	)
}

/** The full balance of the order (what the deposit left), paid or not. */
export function cateringBalanceCents(
	order: Pick<RestaurantOrder, 'isCatering' | 'totalCents' | 'depositCents'>,
): number {
	if (!order.isCatering) return 0
	return Math.max(
		0,
		order.totalCents - (order.depositCents ?? order.totalCents),
	)
}

/**
 * The columns a paid event sets on a catering order: what was captured. For
 * every other order nothing is set (the total is what was paid).
 */
export function cateringPaidColumns(
	order: Pick<
		RestaurantOrder,
		'isCatering' | 'depositCents' | 'totalCents' | 'giftCardCents'
	>,
): { paidCents: number } | Record<string, never> {
	if (!order.isCatering) return {}
	return { paidCents: orderChargeCents(order) }
}
