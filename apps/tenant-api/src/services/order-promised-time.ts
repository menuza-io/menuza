import { and, eq } from 'drizzle-orm'
import {
	planPromisedDelay,
	PROMISED_DELAY_NOTIFY_MINUTES,
	type PromisedDelayMinutes,
	type PromisedDelayRefusal,
} from '@repo/common/restaurant-orders'
import { restaurantOrders, type RestaurantOrder } from '@repo/tenant-db'
import {
	queueEtaChangedMessage,
	type OrderMessageContext,
	type OrderMessageTx,
} from './order-messages.ts'

/**
 * The one implementation of "push the promised time back" (#109), shared by
 * `PATCH /operator/orders/:id` and the kitchen's `delay` command. Runs inside
 * the caller's exclusive order transaction.
 *
 * Rules: only a live order (accepted, preparing, ready) with a promised time;
 * the caller names the `promisedVersion` it saw; at most 90 minutes in total.
 * Both ends of a delivery range move. A single push-back of 10 minutes or more
 * queues the guest's `eta_changed` message (at most one per order and channel,
 * rendered from the order when it is sent, so it carries the newest time).
 */

export const PROMISED_DELAY_MESSAGES: Record<PromisedDelayRefusal, string> = {
	order_closed: 'This order is closed. Its time can no longer change.',
	no_promised_time: 'This order has no promised time to change.',
	stale_version:
		'The promised time changed on another screen. Refresh and try again.',
	delay_limit: 'This order has already been pushed back 90 minutes.',
}

export type PromisedDelayResult =
	| { ok: true; order: RestaurantOrder }
	| { ok: false; status: 409; code: PromisedDelayRefusal; message: string }

export async function applyPromisedDelay(
	tx: OrderMessageTx,
	order: RestaurantOrder,
	input: { minutes: PromisedDelayMinutes; expectedVersion: number },
	now: Date,
	ctx: OrderMessageContext,
): Promise<PromisedDelayResult> {
	const refuse = (code: PromisedDelayRefusal): PromisedDelayResult => ({
		ok: false,
		status: 409,
		code,
		message: PROMISED_DELAY_MESSAGES[code],
	})
	const plan = planPromisedDelay(order, input.minutes, input.expectedVersion)
	if (!plan.ok) return refuse(plan.code)
	const [updated] = await tx
		.update(restaurantOrders)
		.set({
			promisedAt: plan.promisedAt,
			promisedUntil: plan.promisedUntil,
			promisedVersion: plan.version,
			promisedDelayMinutes: plan.delayMinutes,
			updatedAt: now,
		})
		.where(
			and(
				eq(restaurantOrders.id, order.id),
				eq(restaurantOrders.promisedVersion, order.promisedVersion),
			),
		)
		.returning()
	if (!updated) return refuse('stale_version')
	if (input.minutes >= PROMISED_DELAY_NOTIFY_MINUTES) {
		await queueEtaChangedMessage(tx, updated, ctx)
	}
	return { ok: true, order: updated }
}
