import { and, desc, eq } from 'drizzle-orm'
import {
	cateringPayments,
	restaurantOrderRefunds,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { type OrderTx } from './order-service.ts'

/**
 * Refunds of a catering order (#361). The order was paid through up to two
 * payments: the deposit (the order's own session) and, later, the balance
 * (`catering_payments`). A provider refund returns money on one payment, so a
 * refund is booked against the payment that can cover it, the balance first:
 * a refund never asks the provider for more than that payment took, however
 * the total is split. A cancel's full refund that spans both pays back the
 * first payment now and leaves the rest owed (the orders tick books it).
 */

type Pool = {
	processor: 'connect' | 'checkout'
	sessionId: string
	/** Null means the order's own `payment_id`. */
	paymentId: string | null
	paidCents: number
	kind: 'balance' | 'deposit'
}

export type CateringRefundPick =
	| {
			ok: true
			processor: 'connect' | 'checkout'
			sessionId: string
			paymentId: string | null
			amountCents: number
			/** The request wanted more than this payment holds: the rest is owed. */
			remainderOwed: boolean
	  }
	| { ok: false; largestCents: number }

/** What each payment of the order took, the balance first. */
async function paymentPools(
	tx: OrderTx,
	order: RestaurantOrder,
): Promise<Pool[]> {
	const pools: Pool[] = []
	const balances = await tx
		.select()
		.from(cateringPayments)
		.where(
			and(
				eq(cateringPayments.orderId, order.id),
				eq(cateringPayments.status, 'paid'),
			),
		)
		.orderBy(desc(cateringPayments.paidAt))
	for (const payment of balances) {
		if (!payment.sessionId || !payment.processor) continue
		pools.push({
			kind: 'balance',
			processor: payment.processor,
			sessionId: payment.sessionId,
			paymentId: payment.paymentId,
			paidCents: payment.amountCents,
		})
	}
	if (order.paymentSessionId && order.paymentProcessor) {
		pools.push({
			kind: 'deposit',
			processor: order.paymentProcessor,
			sessionId: order.paymentSessionId,
			paymentId: null,
			paidCents: order.depositCents ?? order.totalCents - order.giftCardCents,
		})
	}
	return pools
}

/** Provider refunds already asked of one session: pending, or succeeded and not reversed. */
async function refundedOnSession(
	tx: OrderTx,
	orderId: string,
	sessionId: string,
): Promise<number> {
	const rows = await tx
		.select({
			amountCents: restaurantOrderRefunds.amountCents,
			status: restaurantOrderRefunds.status,
			reversedAt: restaurantOrderRefunds.reversedAt,
		})
		.from(restaurantOrderRefunds)
		.where(
			and(
				eq(restaurantOrderRefunds.orderId, orderId),
				eq(restaurantOrderRefunds.kind, 'provider'),
				eq(restaurantOrderRefunds.sessionId, sessionId),
			),
		)
	return rows.reduce(
		(sum, row) =>
			row.status === 'pending' ||
			(row.status === 'succeeded' && row.reversedAt == null)
				? sum + row.amountCents
				: sum,
		0,
	)
}

/**
 * Picks the payment a provider refund of `amountCents` is booked against.
 * `refundableCents` is what the whole order can still give back (the caller
 * already checked the amount against it); each payment is also limited by its
 * own refunds, so a refund cannot exceed what that payment took.
 */
export async function pickCateringRefundPayment(
	tx: OrderTx,
	order: RestaurantOrder,
	input: { amountCents: number; full: boolean; refundableCents: number },
): Promise<CateringRefundPick> {
	let remaining = input.refundableCents
	const allowed: Array<Pool & { allowedCents: number }> = []
	for (const pool of await paymentPools(tx, order)) {
		const used = await refundedOnSession(tx, order.id, pool.sessionId)
		const allowedCents = Math.max(0, Math.min(pool.paidCents - used, remaining))
		remaining -= allowedCents
		allowed.push({ ...pool, allowedCents })
	}
	const covering = allowed.find(
		(pool) => pool.allowedCents >= input.amountCents,
	)
	if (covering) {
		return {
			ok: true,
			processor: covering.processor,
			sessionId: covering.sessionId,
			paymentId: covering.kind === 'balance' ? covering.paymentId : null,
			amountCents: input.amountCents,
			remainderOwed: false,
		}
	}
	const largest = Math.max(0, ...allowed.map((pool) => pool.allowedCents))
	if (input.full) {
		const first = allowed.find((pool) => pool.allowedCents > 0)
		if (first) {
			return {
				ok: true,
				processor: first.processor,
				sessionId: first.sessionId,
				paymentId: first.kind === 'balance' ? first.paymentId : null,
				amountCents: first.allowedCents,
				remainderOwed: true,
			}
		}
	}
	return { ok: false, largestCents: largest }
}
