import {
	getTenantDb,
	rsvHolds,
	rsvLocationSettings,
	rsvMessages,
	rsvOutbox,
	rsvRateCounters,
	rsvReservations,
	rsvIdempotencyKeys,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { type ReservationsContext } from '@repo/reservations'
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	lt,
	lte,
	min,
	sql,
} from 'drizzle-orm'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import { transitionReservationStatus } from './rsv-booking-service.ts'
import {
	deliverDueMessages,
	emptyDeliveryTotals,
	nextMessageDueAt,
	type DeliveryTotals,
} from './rsv-message-service.ts'
import { reconcileGuestCounters } from './rsv-guestbook-service.ts'
import { runNotifyMeMatching } from './rsv-notify-service.ts'
import {
	deliverOutbox,
	type AlertOutcome,
	type ManagerAlertEvent,
	type OutboxTotals,
} from './rsv-outbox.ts'

/**
 * The regional reservations tick. One pass per organization, driven by the
 * hourly cron fan-out, the Node interval and the Durable Object alarm. Every
 * task is idempotent, so a doubled or partial pass loses nothing. Results carry
 * counts and short codes only.
 */

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

export const AUTO_NO_SHOW_BATCH = 100
/** Reservations older than this are history, not something to mark no-show now. */
export const AUTO_NO_SHOW_LOOKBACK_MS = 2 * DAY_MS
export const IDEMPOTENCY_RETENTION_MS = 48 * 60 * MINUTE_MS
export const RATE_COUNTER_RETENTION_MS = 2 * DAY_MS
export const HOLD_RETENTION_MS = 7 * DAY_MS
export const MESSAGE_RETENTION_MS = 180 * DAY_MS
export const OUTBOX_RETENTION_MS = 30 * DAY_MS
/** A follow-up further out than this is left to the hourly cron. */
export const FOLLOW_UP_HORIZON_MS = 60 * MINUTE_MS
export const TICK_SYSTEM_ACTOR = 'reservations-tick'

export const RESERVATIONS_TICK_TASK_NAMES = [
	'expire_holds',
	'expire_requests',
	'auto_no_show',
	'waitlist_offers',
	'notify_me_match',
	'deliver_messages',
	'deliver_outbox',
	'reconcile_guest_counters',
	'purge',
] as const
export type ReservationsTickTaskName =
	(typeof RESERVATIONS_TICK_TASK_NAMES)[number]

export type ReservationsTickSkipReason =
	| 'busy'
	| 'no_database'
	| 'no_reservations'
	| 'flags_unknown'
	| 'reservations_disabled'
	| 'region_mismatch'

export type ReservationsTickTask = {
	name: ReservationsTickTaskName
	status: 'ok' | 'skipped' | 'error'
	/** Rows the task acted on (expired, marked, queued, delivered, purged). */
	count: number
	reason?: string
	detail?: Record<string, number>
}

export type ReservationsTickResult = {
	orgId: string
	status: 'ran' | 'skipped'
	reason?: ReservationsTickSkipReason
	at: number
	tasks: ReservationsTickTask[]
	messages: DeliveryTotals
	outbox: OutboxTotals
	needsFollowUp: boolean
	nextDueAt: number | null
}

const emptyOutbox = (): OutboxTotals => ({
	groups: 0,
	delivered: 0,
	retried: 0,
	failed: 0,
})

export type ReservationsTickDeps = {
	now: () => number
	getContext: (
		orgId: string,
		now: number,
	) => Promise<ReservationsContext | null>
	regionMatches: (dataRegion: string | null) => boolean
	outboxPost?: (event: ManagerAlertEvent) => Promise<AlertOutcome>
}

const defaultDeps: ReservationsTickDeps = {
	now: () => Date.now(),
	getContext: (orgId, now) => getReservationsContext(orgId, { now }),
	regionMatches: (dataRegion) =>
		dataRegion === null || orgMatchesNodeRegion(dataRegion),
}

export type RunReservationsTickOptions = {
	db?: TenantDatabase
	deps?: Partial<ReservationsTickDeps>
}

const inFlight = new Set<string>()

function skipped(
	orgId: string,
	at: number,
	reason: ReservationsTickSkipReason,
): ReservationsTickResult {
	return {
		orgId,
		status: 'skipped',
		reason,
		at,
		tasks: [],
		messages: emptyDeliveryTotals(),
		outbox: emptyOutbox(),
		needsFollowUp: false,
		nextDueAt: null,
	}
}

async function guarded(
	name: ReservationsTickTaskName,
	run: () => Promise<Omit<ReservationsTickTask, 'name'>>,
): Promise<ReservationsTickTask> {
	try {
		return { name, ...(await run()) }
	} catch (error) {
		// A name only: drizzle errors quote bound values.
		console.error(
			`Reservations tick: ${name} failed`,
			error instanceof Error ? error.name : 'unknown',
		)
		return { name, status: 'error', count: 0, reason: 'task_failed' }
	}
}

async function autoNoShow(
	orgId: string,
	db: TenantDatabase,
	now: number,
): Promise<number> {
	const settings = await db
		.select({
			locationId: rsvLocationSettings.locationId,
			afterMin: rsvLocationSettings.autoNoShowAfterMin,
		})
		.from(rsvLocationSettings)
		.where(isNotNull(rsvLocationSettings.autoNoShowAfterMin))
	let marked = 0
	for (const setting of settings) {
		const afterMs = (setting.afterMin ?? 0) * MINUTE_MS
		// Running late pushes the grace period out by the minutes the guest gave.
		const candidates = await db
			.select({
				id: rsvReservations.id,
				startAt: rsvReservations.startAt,
				runningLateMin: rsvReservations.runningLateMin,
			})
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, setting.locationId),
					inArray(rsvReservations.status, ['booked', 'confirmed']),
					lte(rsvReservations.startAt, now - afterMs),
					gt(rsvReservations.startAt, now - AUTO_NO_SHOW_LOOKBACK_MS),
				),
			)
			.orderBy(asc(rsvReservations.startAt))
			.limit(AUTO_NO_SHOW_BATCH)
		for (const row of candidates) {
			const dueAt =
				row.startAt + (row.runningLateMin ?? 0) * MINUTE_MS + afterMs
			if (dueAt > now) continue
			try {
				await transitionReservationStatus({
					orgId,
					reservationId: row.id,
					actorId: TICK_SYSTEM_ACTOR,
					actorKind: 'system',
					input: { status: 'no_show', reason: 'auto_no_show', nowMs: now },
				})
				marked++
			} catch (error) {
				// Moved to another status in the meantime: nothing to do.
				if (!(error instanceof Error) || error.name !== 'HttpError') throw error
			}
		}
	}
	return marked
}

async function purge(db: TenantDatabase, now: number): Promise<number> {
	let purged = 0
	const count = (result: { rowsAffected?: number } | unknown): number =>
		Number((result as { rowsAffected?: number }).rowsAffected ?? 0)
	purged += count(
		await db
			.delete(rsvIdempotencyKeys)
			.where(lt(rsvIdempotencyKeys.createdAt, now - IDEMPOTENCY_RETENTION_MS)),
	)
	purged += count(
		await db
			.delete(rsvRateCounters)
			.where(lt(rsvRateCounters.windowStart, now - RATE_COUNTER_RETENTION_MS)),
	)
	purged += count(
		await db
			.delete(rsvHolds)
			.where(
				and(
					inArray(rsvHolds.status, ['released', 'expired']),
					lt(rsvHolds.expiresAt, now - HOLD_RETENTION_MS),
				),
			),
	)
	purged += count(
		await db
			.delete(rsvMessages)
			.where(
				and(
					inArray(rsvMessages.status, [
						'sent',
						'failed',
						'cancelled',
						'suppressed',
						'dropped',
					]),
					lt(rsvMessages.createdAt, now - MESSAGE_RETENTION_MS),
				),
			),
	)
	purged += count(
		await db
			.delete(rsvOutbox)
			.where(
				and(
					inArray(rsvOutbox.status, ['sent', 'failed']),
					lt(rsvOutbox.createdAt, now - OUTBOX_RETENTION_MS),
				),
			),
	)
	return purged
}

async function earliestDue(
	db: TenantDatabase,
	now: number,
): Promise<number | null> {
	const candidates: number[] = []
	const push = (value: number | null | undefined) => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			candidates.push(value)
		}
	}
	push(await nextMessageDueAt(db))
	const [outbox] = await db
		.select({ at: min(rsvOutbox.nextAttemptAt) })
		.from(rsvOutbox)
		// Only what `deliverOutbox` posts: a pending row of another kind would
		// look due forever and keep the alarm re-arming.
		.where(
			and(eq(rsvOutbox.kind, 'manager_alert'), eq(rsvOutbox.status, 'pending')),
		)
	push(outbox?.at)
	const [holds] = await db
		.select({ at: min(rsvHolds.expiresAt) })
		.from(rsvHolds)
		.where(eq(rsvHolds.status, 'active'))
	push(holds?.at)
	const [requests] = await db
		.select({ at: min(rsvReservations.requestDeadlineAt) })
		.from(rsvReservations)
		.where(eq(rsvReservations.status, 'pending_approval'))
	push(requests?.at)
	const [payments] = await db
		.select({ at: min(rsvReservations.paymentExpiresAt) })
		.from(rsvReservations)
		.where(eq(rsvReservations.status, 'pending_payment'))
	push(payments?.at)
	const [offers] = await db
		.select({ at: min(rsvWaitlistEntries.responseDeadlineAt) })
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.status, 'notified'))
	push(offers?.at)
	if (candidates.length === 0) return null
	return Math.max(now, Math.min(...candidates))
}

export async function runReservationsTickForOrg(
	orgId: string,
	options: RunReservationsTickOptions = {},
): Promise<ReservationsTickResult> {
	const deps: ReservationsTickDeps = { ...defaultDeps, ...options.deps }
	const now = deps.now()
	if (inFlight.has(orgId)) return skipped(orgId, now, 'busy')
	inFlight.add(orgId)
	try {
		let db: TenantDatabase
		try {
			db = options.db ?? (await getTenantDb(orgId))
		} catch {
			return skipped(orgId, now, 'no_database')
		}

		const [anySettings] = await db
			.select({ n: sql<number>`1` })
			.from(rsvLocationSettings)
			.limit(1)
		if (!anySettings) {
			const [anyMessage] = await db
				.select({ n: sql<number>`1` })
				.from(rsvMessages)
				.limit(1)
			if (!anyMessage) return skipped(orgId, now, 'no_reservations')
		}

		const context = await deps.getContext(orgId, now)
		if (!context) return skipped(orgId, now, 'flags_unknown')
		if (!deps.regionMatches(context.dataRegion ?? null)) {
			return skipped(orgId, now, 'region_mismatch')
		}
		const { features } = context
		const tasks: ReservationsTickTask[] = []

		// Retention runs whatever the flags say: switching the module off must
		// not keep rows past their period.
		if (!features.enabled) {
			tasks.push(
				await guarded('purge', async () => ({
					status: 'ok',
					count: await purge(db, now),
				})),
			)
			const result = skipped(orgId, now, 'reservations_disabled')
			return { ...result, tasks }
		}

		let swept: {
			expiredHolds: number
			expiredPendingPayments: number
			expiredPendingRequests: number
			expiredWaitlistOffers: number
		} | null = null
		try {
			// The write gate sweeps every location, bumps the day versions it
			// touched and queues `request_declined` for lapsed requests.
			swept = await withReservationWrite(
				{ orgId, db, now },
				async (_tx, h) => ({
					expiredHolds: h.swept.expiredHolds,
					expiredPendingPayments: h.swept.expiredPendingPayments,
					expiredPendingRequests: h.swept.expiredPendingRequests,
					expiredWaitlistOffers: h.swept.expiredWaitlistOffers,
				}),
			)
		} catch (error) {
			console.error(
				'Reservations tick: sweep failed',
				error instanceof Error ? error.name : 'unknown',
			)
		}
		tasks.push(
			swept
				? {
						name: 'expire_holds',
						status: 'ok',
						count: swept.expiredHolds + swept.expiredPendingPayments,
						detail: {
							holds: swept.expiredHolds,
							pendingPayments: swept.expiredPendingPayments,
						},
					}
				: {
						name: 'expire_holds',
						status: 'error',
						count: 0,
						reason: 'task_failed',
					},
			swept
				? {
						name: 'expire_requests',
						status: 'ok',
						count: swept.expiredPendingRequests,
					}
				: {
						name: 'expire_requests',
						status: 'error',
						count: 0,
						reason: 'task_failed',
					},
		)

		tasks.push(
			await guarded('auto_no_show', async () => ({
				status: 'ok',
				count: await autoNoShow(orgId, db, now),
			})),
		)

		let nextNotifyDue: number | null = null
		if (features.waitlist) {
			tasks.push(
				swept
					? {
							name: 'waitlist_offers',
							status: 'ok',
							count: swept.expiredWaitlistOffers,
						}
					: {
							name: 'waitlist_offers',
							status: 'error',
							count: 0,
							reason: 'task_failed',
						},
			)
			tasks.push(
				await guarded('notify_me_match', async () => {
					const out = await runNotifyMeMatching(orgId, { db, now })
					nextNotifyDue = out.needsFollowUp ? out.nextDueAt : null
					return {
						status: 'ok',
						count: out.notified,
						detail: { notified: out.notified, expired: out.expired },
					}
				}),
			)
		} else {
			tasks.push(
				{
					name: 'waitlist_offers',
					status: 'skipped',
					count: 0,
					reason: 'waitlist_disabled',
				},
				{
					name: 'notify_me_match',
					status: 'skipped',
					count: 0,
					reason: 'waitlist_disabled',
				},
			)
		}

		let messages = emptyDeliveryTotals()
		tasks.push(
			await guarded('deliver_messages', async () => {
				messages = await deliverDueMessages(orgId, { db, now })
				return {
					status: 'ok',
					count: messages.sent,
					detail: { ...messages },
				}
			}),
		)

		let outbox = emptyOutbox()
		tasks.push(
			await guarded('deliver_outbox', async () => {
				outbox = await deliverOutbox(db, {
					now,
					...(deps.outboxPost ? { post: deps.outboxPost } : {}),
				})
				return { status: 'ok', count: outbox.delivered, detail: { ...outbox } }
			}),
		)

		tasks.push(
			await guarded('reconcile_guest_counters', async () => {
				const out = await reconcileGuestCounters(db, now)
				return {
					status: 'ok',
					count: out.repaired,
					detail: { checked: out.checked, repaired: out.repaired },
				}
			}),
		)

		tasks.push(
			await guarded('purge', async () => ({
				status: 'ok',
				count: await purge(db, now),
			})),
		)

		let nextDueAt: number | null = null
		try {
			nextDueAt = await earliestDue(db, now)
		} catch {
			nextDueAt = null
		}
		if (nextNotifyDue !== null) {
			nextDueAt =
				nextDueAt === null ? nextNotifyDue : Math.min(nextDueAt, nextNotifyDue)
		}
		const needsFollowUp =
			nextDueAt !== null && nextDueAt <= now + FOLLOW_UP_HORIZON_MS
		return {
			orgId,
			status: 'ran',
			at: now,
			tasks,
			messages,
			outbox,
			needsFollowUp,
			nextDueAt: needsFollowUp ? nextDueAt : null,
		}
	} finally {
		inFlight.delete(orgId)
	}
}

export type ReservationsTickAggregate = {
	orgsRan: number
	orgsSkipped: number
	/** Organizations not reached before the deadline. */
	orgsDeferred: number
	holdsExpired: number
	requestsExpired: number
	noShowsMarked: number
	messagesSent: number
	alertsDelivered: number
	errors: number
}

export function emptyReservationsAggregate(): ReservationsTickAggregate {
	return {
		orgsRan: 0,
		orgsSkipped: 0,
		orgsDeferred: 0,
		holdsExpired: 0,
		requestsExpired: 0,
		noShowsMarked: 0,
		messagesSent: 0,
		alertsDelivered: 0,
		errors: 0,
	}
}

export function addToReservationsAggregate(
	total: ReservationsTickAggregate,
	result: ReservationsTickResult,
) {
	if (result.status === 'skipped') {
		total.orgsSkipped++
		return
	}
	total.orgsRan++
	for (const task of result.tasks) {
		if (task.status === 'error') total.errors++
		if (task.name === 'expire_holds') total.holdsExpired += task.count
		if (task.name === 'expire_requests') total.requestsExpired += task.count
		if (task.name === 'auto_no_show') total.noShowsMarked += task.count
	}
	total.messagesSent += result.messages.sent
	total.alertsDelivered += result.outbox.delivered
}

/** Test seam: forget which organizations are mid-tick. */
export function resetReservationsTickLocks() {
	inFlight.clear()
}
