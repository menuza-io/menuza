import { and, asc, eq, lte, min } from 'drizzle-orm'
import {
	getTenantDb,
	restaurantOrders,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'

import { errorLogFields } from '../lib/error-log.ts'
import { kickOrderRefundExecute } from '../lib/order-refund-kick.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	runOrderMessagesTickForOrg,
	type OrderMessagesTickResult,
} from './order-message-send.ts'
import { processOwedCancelRefunds } from './order-provider-refund-service.ts'
import {
	applyOrderStatusPatchInTx,
	orderWriteQueues,
	runExclusive,
	settleOrderWriteQueues,
	type CancelRefundOutcome,
} from './order-service.ts'

/**
 * Manual acceptance timeout (#107): an order still `pending_acceptance` past
 * its `acceptance_deadline_at` is turned down with `not_accepted_in_time`,
 * `cancelled_by = 'system'`. It is the operator's own rejection
 * (`applyOrderStatusPatchInTx`): discount uses released, loyalty and stock
 * settled, the guest's `cancelled` message queued, and for a paid online order
 * a full provider refund booked (origin `system`) and handed to the App with
 * the ids-only kick after commit. A handoff order is simply cancelled.
 *
 * Each order is decided in its own transaction under the org lock, and only
 * while it still waits and its deadline has passed, so an accept that won
 * the race (or a second tick) leaves it alone. Accepting after the deadline
 * but before this ran is allowed.
 */

/** Orders turned down per pass; the rest wait for the next one. */
export const ORDER_ACCEPTANCE_BATCH = 100

export type OrderAcceptanceTickResult = {
	/** Orders turned down now (`not_accepted_in_time`). */
	rejected: number
	/** Provider refunds booked for them (paid online orders). */
	refundsBooked: number
	/** The earliest deadline still waiting (epoch ms), for the next alarm. */
	nextDeadlineAt: number | null
}

export async function processOrderAcceptance(
	orgId: string,
	options: { now?: Date; db?: TenantDatabase } = {},
): Promise<OrderAcceptanceTickResult> {
	const now = options.now ?? new Date()
	const db = options.db ?? (await getTenantDb(orgId))
	const due = await db
		.select({ id: restaurantOrders.id })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.status, 'pending_acceptance'),
				lte(restaurantOrders.acceptanceDeadlineAt, now),
			),
		)
		.orderBy(asc(restaurantOrders.acceptanceDeadlineAt))
		.limit(ORDER_ACCEPTANCE_BATCH)

	let rejected = 0
	const refundIds: string[] = []
	for (const { id } of due) {
		const queues = orderWriteQueues()
		let outcome: CancelRefundOutcome | null = null
		const decided = await decideTimeout(orgId, id, () =>
			runExclusive(orgId, () =>
				retryOnSqliteBusy(() =>
					runTenantTransaction(db, async (tx) => {
						outcome = null
						const [order] = await tx
							.select()
							.from(restaurantOrders)
							.where(
								and(
									eq(restaurantOrders.id, id),
									eq(restaurantOrders.orgId, orgId),
								),
							)
							.limit(1)
						if (
							!order ||
							order.status !== 'pending_acceptance' ||
							!order.acceptanceDeadlineAt ||
							order.acceptanceDeadlineAt.getTime() > now.getTime()
						) {
							return false
						}
						const applied = await applyOrderStatusPatchInTx(
							tx,
							order,
							{ status: 'cancelled', rejectReason: 'not_accepted_in_time' },
							{
								cancel: {
									mayRefund: true,
									origin: 'system',
									actorId: 'system',
									cancelledBy: 'system',
								},
								queues,
								now,
							},
						)
						outcome = applied.refund
						return applied.result.ok
					}),
				),
			),
		)
		await settleOrderWriteQueues(orgId, queues)
		if (!decided) continue
		rejected++
		const booked = outcome as CancelRefundOutcome | null
		if (booked?.refund && !booked.replayed) {
			refundIds.push(booked.refund.refundId)
		}
	}
	// The App executes each refund; ids only leave the region.
	if (refundIds.length > 0) kickOrderRefundExecute(orgId, refundIds)

	const [next] = await db
		.select({ at: min(restaurantOrders.acceptanceDeadlineAt) })
		.from(restaurantOrders)
		.where(eq(restaurantOrders.status, 'pending_acceptance'))
	const nextAt = next?.at ?? null
	return {
		rejected,
		refundsBooked: refundIds.length,
		nextDeadlineAt: nextAt ? new Date(nextAt).getTime() : null,
	}
}

/** One order's timeout; a failure is logged by ids and left for the next pass. */
async function decideTimeout(
	orgId: string,
	orderId: string,
	run: () => Promise<boolean>,
): Promise<boolean> {
	try {
		return await run()
	} catch (error) {
		console.error(
			'Order acceptance timeout failed',
			orgId,
			orderId,
			errorLogFields(error),
		)
		return false
	}
}

export type OrdersTickResult = OrderMessagesTickResult & {
	acceptanceRejected: number
	/** Cancel refunds still owed that were booked now (backstop sweep). */
	owedRefundsBooked: number
}

/**
 * The orders tick for one organization (`POST /api/order-messages/tick`, the
 * Durable Object alarm, the Node interval and the hourly fan-out): the
 * acceptance timeout first, then cancel refunds still owed, then guest order
 * messages. Asks for a follow-up at
 * the earliest of the next message retry and the next acceptance deadline.
 * Counts only.
 */
export async function runOrdersTickForOrg(
	orgId: string,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<OrdersTickResult> {
	const now = options.now ?? Date.now()
	const db = options.db ?? (await getTenantDb(orgId))
	const acceptance = await processOrderAcceptance(orgId, {
		now: new Date(now),
		db,
	})
	// A cancel that asked for a full refund while another one was pending:
	// normally booked when that refund settles; this catches any left over.
	const owed = await processOwedCancelRefunds(orgId, { now, db }).catch(
		(error: unknown) => {
			console.error(
				'Owed cancel refunds sweep failed',
				orgId,
				errorLogFields(error),
			)
			return { booked: 0 }
		},
	)
	const messages = await runOrderMessagesTickForOrg(orgId, { now, db })
	const due = [messages.nextDueAt, acceptance.nextDeadlineAt].filter(
		(at): at is number => at !== null,
	)
	const nextDueAt = due.length > 0 ? Math.min(...due) : null
	return {
		...messages,
		acceptanceRejected: acceptance.rejected,
		owedRefundsBooked: owed.booked,
		needsFollowUp: nextDueAt !== null,
		nextDueAt,
	}
}

export async function runOrdersTickLogged(
	orgId: string,
): Promise<OrdersTickResult | null> {
	try {
		return await runOrdersTickForOrg(orgId)
	} catch (error) {
		console.error(
			'Orders tick failed for organization',
			orgId,
			errorLogFields(error),
		)
		return null
	}
}
