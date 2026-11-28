import { printDueScheduledOrders } from './print-hooks.ts'
import { processPushReceipts } from './push-service.ts'
import { and, asc, eq, lte, min } from 'drizzle-orm'
import {
	getTenantDb,
	restaurantOrders,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'

import { forEachWithBudget } from '../lib/concurrency.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { drainFormResponseOutbox } from './form-response-outbox.ts'
import { runOrderAlertsTickForOrg } from './order-alerts.ts'
import { kickOrderRefundExecute } from '../lib/order-refund-kick.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	runOrderMessagesTickForOrg,
	type OrderMessagesTickResult,
} from './order-message-send.ts'
import { runCateringTickForOrg } from './catering-tick.ts'
import { runTestOrdersTick } from './test-orders-service.ts'
import { rotateOrgIds } from './loyalty-tick-service.ts'
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
	const { closeForgottenTabs } = await import('./qr-tab-lifecycle.ts')
	const { expireStaleAutoPrints } = await import('./pos-auto-print.ts')
	await closeForgottenTabs(db, { now }).catch((error: unknown) => {
		console.error('Forgotten tab close failed', orgId, errorLogFields(error))
	})
	await expireStaleAutoPrints(db, now).catch((error: unknown) => {
		console.error('Auto-print expiry failed', orgId, errorLogFields(error))
	})
	const messages = await runOrderMessagesTickForOrg(orgId, { now, db })
	// Manager alerts about waiting orders, payments to review, large orders and
	// Station tablets (#131, #300, #190). Ids and numbers only; a failure never
	// stops the rest of the tick.
	const alerts = await runOrderAlertsTickForOrg(orgId, { now, db }).catch(
		(error: unknown) => {
			console.error('Order alerts tick failed', orgId, errorLogFields(error))
			return null
		},
	)
	// Form response alerts the App could not take earlier (#142). Ids only.
	await drainFormResponseOutbox(orgId, { now, db }).catch((error: unknown) => {
		console.error(
			'Form response alert drain failed',
			orgId,
			errorLogFields(error),
		)
	})
	// Delivery receipts of guest pushes sent a while ago, and tokens that turned
	// out invalid (#105). Counts only; a failure never stops the rest of the tick.
	await processPushReceipts(db, now).catch((error: unknown) => {
		console.error('Push receipts sweep failed', orgId, errorLogFields(error))
	})
	// Scheduled orders whose kitchen ticket was held for their fire time go to
	// the cloud printers now (#117); the next fire time wakes this tick again.
	const prints = await printDueScheduledOrders(db, orgId, now).catch(
		(error: unknown) => {
			console.error('Scheduled printing failed', orgId, errorLogFields(error))
			return { printed: 0, nextDueAt: null as number | null }
		},
	)
	// Catering (#124, #361): balance reminders, the day-before alert and quotes
	// nobody paid. Counts only; a failure never stops the rest of the tick.
	const catering = await runCateringTickForOrg(orgId, { now, db }).catch(
		(error: unknown) => {
			console.error('Catering tick failed', orgId, errorLogFields(error))
			return null
		},
	)
	// Free test orders (#119) finish themselves after two hours, and their spent
	// codes are forgotten after a day. Counts only.
	const testOrders = await runTestOrdersTick(orgId, db, now).catch(
		(error: unknown) => {
			console.error('Test orders tick failed', orgId, errorLogFields(error))
			return null
		},
	)
	const due = [
		messages.nextDueAt,
		acceptance.nextDeadlineAt,
		alerts?.nextDueAt ?? null,
		prints.nextDueAt,
		catering?.nextDueAt ?? null,
		testOrders?.nextDueAt ?? null,
	].filter((at): at is number => at !== null)
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

export type OrderAcceptanceSweepResult = {
	rejected: number
	owedRefundsBooked: number
}

/**
 * Only the time-critical half of the orders tick for one organization: the
 * acceptance timeout, then cancel refunds still owed. It leaves guest order
 * messages alone, so the Node acceptance interval keeps the deadline the guest
 * was shown even when message retries are switched off
 * (`ORDER_MESSAGES_TICK_INTERVAL_SECONDS=0`). Counts only; never throws.
 */
export async function runOrderAcceptanceTickLogged(
	orgId: string,
	options: { now?: number } = {},
): Promise<OrderAcceptanceSweepResult | null> {
	try {
		const now = options.now ?? Date.now()
		const db = await getTenantDb(orgId)
		const acceptance = await processOrderAcceptance(orgId, {
			now: new Date(now),
			db,
		})
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
		return {
			rejected: acceptance.rejected,
			owedRefundsBooked: owed.booked,
		}
	} catch (error) {
		console.error(
			'Order acceptance tick failed for organization',
			orgId,
			errorLogFields(error),
		)
		return null
	}
}

/**
 * Runs the acceptance sweep for many organizations with bounded concurrency
 * and a time budget, starting at a different organization each pass so a slow
 * one never starves the rest. Counts only.
 */
export async function fanOutOrderAcceptanceTick(options: {
	orgIds: readonly string[]
	run?: (orgId: string) => Promise<OrderAcceptanceSweepResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
}): Promise<{
	orgs: number
	orgsDeferred: number
	errors: number
	rejected: number
}> {
	const now = options.now ?? Date.now
	const run = options.run ?? ((orgId) => runOrderAcceptanceTickLogged(orgId))
	const total = { orgs: 0, orgsDeferred: 0, errors: 0, rejected: 0 }
	const result = await forEachWithBudget(
		rotateOrgIds(options.orgIds, Math.floor(now() / 60_000)),
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? 25_000),
			now,
		},
		async (orgId) => {
			const swept = await run(orgId)
			if (!swept) {
				total.errors++
				return
			}
			total.orgs++
			total.rejected += swept.rejected
		},
	)
	total.orgsDeferred = result.skipped
	return total
}
