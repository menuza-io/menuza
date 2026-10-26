import { createHash } from 'node:crypto'
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import {
	autoClockOutDeadline,
	autoClockOutInstant,
	dedupeKeys,
	expectedEntryEnd,
	isNoClockInDue,
	isPreShiftReminderDue,
	isOutboxMessageStale,
	isStaffOutboxKind,
	laborPolicyToRules,
	managerOutboxKind,
	missedClockOutReminderDeadline,
	normalizeContactLevel,
	NO_CLOCK_IN_LOOKBACK_MS,
	OUTBOX_MAX_ATTEMPTS,
	outboxRetryDelayMs,
	overtimeAlertFor,
	overtimeStatus,
	parseManagerOutboxKind,
	PRE_SHIFT_MAX_LEAD_MS,
	statusAfterClose,
	type LaborPolicyView,
	type ManagerAlertEvent,
	type ManagerAlertKind,
	type StaffOutboxKind,
} from '@repo/staffing'
import {
	getTenantDb,
	hiringApplications,
	notificationOutbox,
	staffAuditLog,
	staffMembers,
	timeBreaks,
	timeEntries,
	timeEntryEdits,
	type NotificationOutboxRow,
	type StaffMember,
	type TenantDatabase,
	type TimeEntry,
	runTenantTransaction,
} from '@repo/tenant-db'
import { isEmailEnabled } from '../lib/email-switch.ts'
import {
	getScopeFacts,
	getStaffingFeatures,
	type ScopeFacts,
	type StaffingFeatures,
} from '../lib/scope-context.ts'
import {
	sendManagerAlert,
	type ManagerAlertOutcome,
} from '../lib/manager-alerts.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { normalizeStaffLocale, renderStaffEmail } from '../lib/staff-email.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { purgeExpiredApplications } from './hiring-service.ts'
import { runOnboardingTick } from './onboarding-tick.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import { buildScheduleNotice } from './schedule-notify-service.ts'
import { defaultPunchDeps, type ShiftMatcher } from './punch-service.ts'
import { scheduleSeam, type ShiftLister } from './schedule-seam.ts'
import { describeStaffError, type StaffDb } from './staff-audit.ts'
import { getSettings } from './staff-service.ts'
import {
	entryToInput,
	issuesForEntry,
	loadBreaks,
	refreshStaffCaches,
	snapshotCard,
} from './time-entry-calc.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * The regional tick: one idempotent pass over an organization's time clock that
 * closes forgotten shifts (when the policy says so), queues reminders and manager
 * alerts, and delivers what is queued.
 *
 * It runs from three drivers that all call `runStaffTickForOrg`:
 * - the hourly cron fan-out (`POST /api/staff/tick`), the safety net that needs
 *   no new cron slot;
 * - a Durable Object alarm (US Worker runtime), armed by activity and re-armed
 *   while there is something to watch, which makes it sub-hourly;
 * - an in-process interval on the Node (OCI) runtime.
 *
 * Because more than one driver may run, every task is idempotent: a message is
 * queued once per `dedupe_key`, an automatic clock-out is a guarded update, and
 * a second tick for the same organization while one is running returns "busy".
 *
 * Residency: nothing here leaves the region except the manager alert, whose
 * strict contract carries an organization id, a kind, a scope id and a count.
 * Results and logs carry counts and codes, never names, times or pay.
 */

const MS_PER_MINUTE = 60_000
const DAY_MS = 24 * 60 * MS_PER_MINUTE
/** An entry's week is at most seven days back, plus a business-day offset. */
const OVERTIME_LOOKBACK_MS = 8 * DAY_MS

export const TICK_SYSTEM_ACTOR = 'staff-tick'
export const MAX_STAFF_EMAILS_PER_TICK = 100
export const MAX_MANAGER_GROUPS_PER_TICK = 50
const DELIVERY_BATCH = 300
const OUTBOX_RETENTION_MS = 30 * DAY_MS
/** Longer than the longest relevance window (a time card edit notice: 7 days). */
const MAX_PENDING_AGE_MS = 8 * DAY_MS

export const TICK_TASK_NAMES = [
	'auto_clock_out',
	'missed_clock_out',
	'no_clock_in',
	'pre_shift',
	'overtime',
	'hiring_retention',
] as const

export type TickSkipReason =
	| 'busy'
	| 'no_database'
	| 'no_staff'
	| 'flags_unknown'
	| 'staffing_disabled'
	| 'region_mismatch'

export type TickTaskResult = {
	name: string
	status: 'ok' | 'skipped' | 'error'
	/** Messages queued (new dedupe keys only). */
	queued: number
	/** Entries closed (auto clock-out only). */
	closed?: number
	/** Declined applicants purged (hiring retention only). */
	purged?: number
	/** Why the task did nothing, as a short code. */
	reason?: string
}

export type DeliveryTotals = {
	sent: number
	skipped: number
	failed: number
	retry: number
}

export type TickResult = {
	orgId: string
	status: 'ran' | 'skipped'
	reason?: TickSkipReason
	at: number
	tasks: TickTaskResult[]
	staffEmail: DeliveryTotals
	managerAlerts: DeliveryTotals
	/** Whether something is open, queued or scheduled soon, so a timer should come back. */
	needsFollowUp: boolean
}

const emptyTotals = (): DeliveryTotals => ({
	sent: 0,
	skipped: 0,
	failed: 0,
	retry: 0,
})

// ---------------------------------------------------------------------------
// Dependencies (replaceable in tests)
// ---------------------------------------------------------------------------

export type StaffEmailSender = (input: {
	to: string
	toName: string
	subject: string
	html: string
	text: string
}) => Promise<
	| { status: 'success' | 'skipped' }
	| { status: 'error'; error: { message: string; statusCode?: number } }
>

export type TickDeps = {
	now: () => number
	getFeatures: (
		orgId: string,
		now: number,
	) => Promise<{ features: StaffingFeatures; dataRegion: string | null } | null>
	getScope: (
		orgId: string,
		scopeId: string,
		now: number,
	) => Promise<ScopeFacts | null>
	listShifts: ShiftLister
	matchShift: ShiftMatcher
	sendEmail: StaffEmailSender
	notifyManagers: (event: ManagerAlertEvent) => Promise<ManagerAlertOutcome>
	emailEnabled: () => boolean
	regionMatches: (dataRegion: string | null) => boolean
	/** Hooks from later slices (onboarding reminders and the like). */
	extraTasks: () => readonly StaffTickTask[]
}

export const defaultTickDeps: TickDeps = {
	now: () => Date.now(),
	getFeatures: (orgId, now) => getStaffingFeatures(orgId, now),
	getScope: (orgId, scopeId, now) => getScopeFacts(orgId, scopeId, now),
	listShifts: (db, query) => scheduleSeam.listShifts(db, query),
	matchShift: (db, input) => defaultPunchDeps.matchShift(db, input),
	sendEmail: (input) =>
		// No `context`: this is operational mail about a person's own work, so it
		// carries no marketing headers.
		sendTenantEmail(input),
	notifyManagers: sendManagerAlert,
	emailEnabled: isEmailEnabled,
	regionMatches: (dataRegion) =>
		dataRegion === null || orgMatchesNodeRegion(dataRegion),
	extraTasks: () => extraTasks,
}

// ---------------------------------------------------------------------------
// Extension point
// ---------------------------------------------------------------------------

export type StaffTickContext = {
	orgId: string
	db: StaffDb
	now: number
	features: StaffingFeatures
	/** Queue a message once; returns false when this dedupe key already exists. */
	enqueue: (message: QueuedMessage) => Promise<boolean>
}

export type StaffTickTask = {
	name: string
	/** The organization flag that must be on; the master switch always applies. */
	requires: 'enabled' | 'timeclock' | 'scheduling' | 'hiring'
	run: (ctx: StaffTickContext) => Promise<{ queued: number } | void>
}

const extraTasks: StaffTickTask[] = []

/**
 * Later slices (onboarding reminders, certificate expiry) register a task here
 * at start-up. A task runs inside the same pass as the built-in ones: after
 * them, before delivery, behind its own flag, isolated so that a failure in one
 * task never stops another.
 */
export function registerStaffTickTask(task: StaffTickTask) {
	if (extraTasks.some((existing) => existing.name === task.name)) {
		throw new Error(`Staff tick task "${task.name}" is already registered`)
	}
	extraTasks.push(task)
}

export function resetStaffTickTasks() {
	extraTasks.length = 0
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export type QueuedMessage = {
	/** A staff kind, or `manager.<alert kind>`. */
	kind: string
	/** The person the message is about (regional only; never sent to the App). */
	staffId: string
	scopeId: string | null
	dedupeKey: string
	payload: Record<string, unknown>
}

async function enqueue(
	db: StaffDb,
	message: QueuedMessage,
	now: number,
): Promise<boolean> {
	const inserted = await db
		.insert(notificationOutbox)
		.values({
			kind: message.kind,
			staffId: message.staffId,
			scopeId: message.scopeId,
			dedupeKey: message.dedupeKey,
			payload: message.payload,
			nextAttemptAt: now,
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: notificationOutbox.id })
	return inserted.length > 0
}

function managerMessage(
	kind: ManagerAlertKind,
	staffId: string,
	scopeId: string | null,
	dedupeKey: string,
	payload: Record<string, unknown> = {},
): QueuedMessage {
	return {
		kind: managerOutboxKind(kind),
		staffId,
		scopeId,
		dedupeKey,
		payload,
	}
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

type OpenEntry = {
	entry: TimeEntry
	staff: StaffMember
	openBreakStartAt: number | null
}

class TickContext {
	private readonly policies = new Map<string, LaborPolicyView>()
	private readonly shiftEnds = new Map<string, number | null>()

	constructor(
		readonly orgId: string,
		readonly db: StaffDb,
		readonly now: number,
		readonly deps: TickDeps,
	) {}

	async policy(scopeId: string): Promise<LaborPolicyView> {
		const cached = this.policies.get(scopeId)
		if (cached) return cached
		const policy = await resolvePolicy(this.db, scopeId)
		this.policies.set(scopeId, policy)
		return policy
	}

	/** The scheduled end of the shift an entry was matched to, if any. */
	async shiftEndFor(entry: TimeEntry): Promise<number | null> {
		if (!entry.shiftId) return null
		if (this.shiftEnds.has(entry.id)) return this.shiftEnds.get(entry.id)!
		const found = await this.deps.matchShift(this.db, {
			staffId: entry.staffId,
			scopeId: entry.scopeId,
			atMs: entry.clockInAt,
			timeZone: entry.timeZone,
		})
		const end = found && found.id === entry.shiftId ? found.endAt : null
		this.shiftEnds.set(entry.id, end)
		return end
	}
}

async function loadOpenEntries(db: StaffDb): Promise<OpenEntry[]> {
	const rows = await db
		.select({ entry: timeEntries, staff: staffMembers })
		.from(timeEntries)
		.innerJoin(staffMembers, eq(staffMembers.id, timeEntries.staffId))
		.where(and(isNull(timeEntries.clockOutAt), isNull(timeEntries.voidedAt)))
		.orderBy(asc(timeEntries.clockInAt))
	if (rows.length === 0) return []
	const breaks = await db
		.select({ entryId: timeBreaks.entryId, startAt: timeBreaks.startAt })
		.from(timeBreaks)
		.where(
			and(
				inJsonList(
					timeBreaks.entryId,
					rows.map((row) => row.entry.id),
				),
				isNull(timeBreaks.endAt),
				isNull(timeBreaks.voidedAt),
			),
		)
	const openBreak = new Map(breaks.map((b) => [b.entryId, b.startAt]))
	return rows.map((row) => ({
		...row,
		openBreakStartAt: openBreak.get(row.entry.id) ?? null,
	}))
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Closes entries still open past the policy's automatic clock-out time, flags
 * them for review, and queues the notices. Off unless the policy sets
 * `autoClockOutMinutes`. The close is a guarded update (the entry must still be
 * open), so a person who punches out at the same moment wins and nothing is
 * written twice.
 */
async function autoClockOutTask(
	ctx: TickContext,
	open: OpenEntry[],
): Promise<{ result: TickTaskResult; closedIds: Set<string> }> {
	const closedIds = new Set<string>()
	let queued = 0
	for (const item of open) {
		const { entry } = item
		const policy = await ctx.policy(entry.scopeId)
		if (policy.autoClockOutMinutes === null) continue
		const shiftEndAt = await ctx.shiftEndFor(entry)
		const end = expectedEntryEnd({
			clockInAt: entry.clockInAt,
			shiftEndAt,
			longShiftMinutes: policy.longShiftMinutes,
		})
		const dueAt = autoClockOutDeadline({
			policy,
			clockInAt: entry.clockInAt,
			shiftEndAt: end,
		})
		if (dueAt === null || ctx.now < dueAt) continue

		const closeAt = autoClockOutInstant({
			clockInAt: entry.clockInAt,
			shiftEndAt: end,
			dueAt,
			openBreakStartAt: item.openBreakStartAt,
			nowMs: ctx.now,
		})
		try {
			const closed = await retryOnSqliteBusy(() =>
				runTenantTransaction(ctx.db, (tx) =>
					closeEntryAutomatically(tx, ctx, item, policy, closeAt),
				),
			)
			if (closed) {
				closedIds.add(entry.id)
				queued += closed.queued
			}
		} catch (error) {
			console.error(
				'Staff tick: automatic clock-out failed',
				describeStaffError(error),
			)
		}
	}
	return {
		result: {
			name: 'auto_clock_out',
			status: 'ok',
			queued,
			closed: closedIds.size,
		},
		closedIds,
	}
}

async function closeEntryAutomatically(
	tx: StaffDb,
	ctx: TickContext,
	item: OpenEntry,
	policy: LaborPolicyView,
	closeAt: number,
): Promise<{ queued: number } | null> {
	const { entry } = item
	const now = ctx.now

	// Everything below depends on the entry still being open, so the guarded
	// update is the first write: a person who clocked out a moment ago won the
	// race and nothing is changed.
	const breaksBefore = (await loadBreaks(tx, [entry.id])).get(entry.id) ?? []
	const breaksAfter = breaksBefore.map((b) =>
		b.voidedAt === null && b.endAt === null ? { ...b, endAt: closeAt } : b,
	)
	const closedShape: TimeEntry = { ...entry, clockOutAt: closeAt }
	const issues = issuesForEntry(closedShape, breaksAfter, policy, [
		'auto_clock_out',
	])
	const updated = await tx
		.update(timeEntries)
		.set({
			clockOutAt: closeAt,
			clockOutKind: 'auto',
			status: statusAfterClose(issues),
			issues,
			version: entry.version + 1,
			updatedAt: now,
		})
		.where(and(eq(timeEntries.id, entry.id), isNull(timeEntries.clockOutAt)))
		.returning({ id: timeEntries.id })
	if (updated.length === 0) return null

	if (breaksBefore.some((b) => b.voidedAt === null && b.endAt === null)) {
		await tx
			.update(timeBreaks)
			.set({ endAt: closeAt })
			.where(
				and(
					eq(timeBreaks.entryId, entry.id),
					isNull(timeBreaks.endAt),
					isNull(timeBreaks.voidedAt),
				),
			)
	}
	await refreshStaffCaches(
		tx,
		entry.staffId,
		{ clockInAt: entry.clockInAt },
		now,
	)

	const [settled] = await tx
		.select()
		.from(timeEntries)
		.where(eq(timeEntries.id, entry.id))
		.limit(1)
	const settledEntry = settled ?? {
		...closedShape,
		status: statusAfterClose(issues),
	}

	await tx.insert(timeEntryEdits).values({
		entryId: entry.id,
		staffId: entry.staffId,
		scopeId: entry.scopeId,
		editorId: TICK_SYSTEM_ACTOR,
		via: 'auto_clock_out',
		action: 'auto_clock_out',
		reason: 'Closed automatically: no clock-out was recorded.',
		before: snapshotCard(entry, breaksBefore),
		after: snapshotCard(settledEntry, breaksAfter),
		hoursDeltaMinutes: settledEntry.paidMinutes ?? null,
		createdAt: now,
	})
	await tx.insert(staffAuditLog).values({
		actorKind: 'system',
		actorId: TICK_SYSTEM_ACTOR,
		impersonated: false,
		action: 'timeclock.entry.auto_clock_out',
		entityType: 'time_entry',
		entityId: entry.id,
		staffId: entry.staffId,
		scopeId: entry.scopeId,
		sensitivity: 'standard',
		changes: {
			clockOutAt: closeAt,
			autoClockOutMinutes: policy.autoClockOutMinutes,
		},
	})

	let queued = 0
	if (
		await enqueue(
			tx,
			managerMessage(
				'auto_clock_out',
				entry.staffId,
				entry.scopeId,
				dedupeKeys.autoClockOut(entry.id),
				{ entryId: entry.id },
			),
			now,
		)
	) {
		queued++
	}
	if (
		await enqueue(
			tx,
			{
				kind: 'auto_clock_out_notice',
				staffId: entry.staffId,
				scopeId: entry.scopeId,
				dedupeKey: dedupeKeys.autoClockOutNotice(entry.id),
				payload: {
					entryId: entry.id,
					clockInAt: entry.clockInAt,
					clockOutAt: closeAt,
					scopeId: entry.scopeId,
				},
			},
			now,
		)
	) {
		queued++
	}
	return { queued }
}

/**
 * Reminds a person (and tells managers) when an entry is still open well past
 * when the shift should have ended. Off unless the policy sets
 * `missedClockOutReminderMinutes`. An entry the automatic clock-out just closed
 * is skipped: its own notices cover it.
 */
async function missedClockOutTask(
	ctx: TickContext,
	open: OpenEntry[],
	closedIds: ReadonlySet<string>,
): Promise<TickTaskResult> {
	let queued = 0
	for (const { entry, staff } of open) {
		if (closedIds.has(entry.id)) continue
		const policy = await ctx.policy(entry.scopeId)
		if (policy.missedClockOutReminderMinutes === null) continue
		const shiftEndAt = await ctx.shiftEndFor(entry)
		const end = expectedEntryEnd({
			clockInAt: entry.clockInAt,
			shiftEndAt,
			longShiftMinutes: policy.longShiftMinutes,
		})
		const dueAt = missedClockOutReminderDeadline({
			policy,
			clockInAt: entry.clockInAt,
			shiftEndAt: end,
		})
		if (dueAt === null || ctx.now < dueAt) continue

		if (
			await enqueue(
				ctx.db,
				managerMessage(
					'missed_clock_out',
					entry.staffId,
					entry.scopeId,
					dedupeKeys.missedClockOut(entry.id),
					{ entryId: entry.id },
				),
				ctx.now,
			)
		) {
			queued++
		}
		if (staff.email && staff.status === 'active') {
			if (
				await enqueue(
					ctx.db,
					{
						kind: 'missed_clock_out_reminder',
						staffId: entry.staffId,
						scopeId: entry.scopeId,
						dedupeKey: dedupeKeys.missedClockOutReminder(entry.id),
						payload: {
							entryId: entry.id,
							clockInAt: entry.clockInAt,
							scopeId: entry.scopeId,
						},
					},
					ctx.now,
				)
			) {
				queued++
			}
		}
	}
	return { name: 'missed_clock_out', status: 'ok', queued }
}

/**
 * Alerts managers when a scheduled person has not clocked in `noClockInAlertMinutes`
 * after the shift began. Needs the schedule; reports "schedule_unavailable" until
 * scheduling registers a lister.
 */
async function noClockInTask(ctx: TickContext): Promise<TickTaskResult> {
	const shifts = await ctx.deps.listShifts(ctx.db, {
		startsFromMs: ctx.now - NO_CLOCK_IN_LOOKBACK_MS,
		startsToMs: ctx.now,
	})
	if (shifts === undefined) {
		return {
			name: 'no_clock_in',
			status: 'skipped',
			queued: 0,
			reason: 'schedule_unavailable',
		}
	}
	let queued = 0
	const staffIds = [...new Set(shifts.map((shift) => shift.staffId))]
	const people = await loadStaff(ctx.db, staffIds)
	for (const shift of shifts) {
		const policy = await ctx.policy(shift.scopeId)
		if (!policy.timeTrackingEnabled) continue
		if (
			!isNoClockInDue({
				shiftStartAt: shift.startAt,
				shiftEndAt: shift.endAt,
				alertMinutes: policy.noClockInAlertMinutes,
				nowMs: ctx.now,
			})
		) {
			continue
		}
		if (people.get(shift.staffId)?.status !== 'active') continue
		if (await hasClockedInForShift(ctx.db, shift, policy)) continue
		if (
			await enqueue(
				ctx.db,
				managerMessage(
					'no_clock_in',
					shift.staffId,
					shift.scopeId,
					dedupeKeys.noClockIn(shift.id, shift.staffId),
					{ shiftId: shift.id },
				),
				ctx.now,
			)
		) {
			queued++
		}
	}
	return { name: 'no_clock_in', status: 'ok', queued }
}

async function hasClockedInForShift(
	db: StaffDb,
	shift: { id: string; staffId: string; startAt: number; endAt: number },
	policy: LaborPolicyView,
): Promise<boolean> {
	// Someone who clocked in early (within the early window, or two hours when
	// early clock-in is not limited) is on shift, as is anyone matched to it.
	const earliest =
		shift.startAt - (policy.preventEarlyMinutes ?? 120) * MS_PER_MINUTE
	const rows = await db
		.select({ id: timeEntries.id })
		.from(timeEntries)
		.where(
			and(
				eq(timeEntries.staffId, shift.staffId),
				isNull(timeEntries.voidedAt),
				gte(timeEntries.clockInAt, earliest),
				lte(timeEntries.clockInAt, shift.endAt),
			),
		)
		.limit(1)
	return rows.length > 0
}

async function loadStaff(
	db: StaffDb,
	ids: readonly string[],
): Promise<Map<string, StaffMember>> {
	if (ids.length === 0) return new Map()
	const rows = await db
		.select()
		.from(staffMembers)
		.where(inJsonList(staffMembers.id, [...ids]))
	return new Map(rows.map((row) => [row.id, row]))
}

/** Emails a person before a scheduled shift. Needs the schedule. */
async function preShiftTask(
	ctx: TickContext,
): Promise<{ result: TickTaskResult; upcoming: number }> {
	const shifts = await ctx.deps.listShifts(ctx.db, {
		startsFromMs: ctx.now,
		startsToMs: ctx.now + PRE_SHIFT_MAX_LEAD_MS,
	})
	if (shifts === undefined) {
		return {
			result: {
				name: 'pre_shift',
				status: 'skipped',
				queued: 0,
				reason: 'schedule_unavailable',
			},
			upcoming: 0,
		}
	}
	let queued = 0
	const people = await loadStaff(ctx.db, [
		...new Set(shifts.map((shift) => shift.staffId)),
	])
	for (const shift of shifts) {
		const policy = await ctx.policy(shift.scopeId)
		if (
			!isPreShiftReminderDue({
				shiftStartAt: shift.startAt,
				reminderMinutes: policy.preShiftReminderMinutes,
				nowMs: ctx.now,
			})
		) {
			continue
		}
		const person = people.get(shift.staffId)
		if (!person || person.status !== 'active' || !person.email) continue
		if (
			await enqueue(
				ctx.db,
				{
					kind: 'shift_reminder',
					staffId: shift.staffId,
					scopeId: shift.scopeId,
					dedupeKey: dedupeKeys.shiftReminder(shift.id, shift.staffId),
					payload: {
						shiftId: shift.id,
						startAt: shift.startAt,
						endAt: shift.endAt,
						scopeId: shift.scopeId,
					},
				},
				ctx.now,
			)
		) {
			queued++
		}
	}
	return {
		result: { name: 'pre_shift', status: 'ok', queued },
		upcoming: shifts.length,
	}
}

/**
 * Alerts managers when someone working now is close to (or past) an overtime
 * threshold. Measured with the shared time math, so it matches the timesheet.
 * Off unless the scope's policy has overtime rules and an alert window.
 */
async function overtimeTask(
	ctx: TickContext,
	open: OpenEntry[],
	closedIds: ReadonlySet<string>,
): Promise<TickTaskResult> {
	let queued = 0
	for (const { entry } of open) {
		if (closedIds.has(entry.id)) continue
		const policy = await ctx.policy(entry.scopeId)
		if (policy.overtimeAlertMinutes === null) continue
		const rules = laborPolicyToRules(policy)
		if (!rules.weeklyOvertime && !rules.dailyOvertime) continue

		const rows = await ctx.db
			.select()
			.from(timeEntries)
			.where(
				and(
					eq(timeEntries.staffId, entry.staffId),
					isNull(timeEntries.voidedAt),
					gte(timeEntries.clockInAt, ctx.now - OVERTIME_LOOKBACK_MS),
				),
			)
		const breaks = await loadBreaks(
			ctx.db,
			rows.map((row) => row.id),
		)
		const status = overtimeStatus({
			entries: rows.map((row) => entryToInput(row, breaks.get(row.id) ?? [])),
			scopeId: entry.scopeId,
			rules,
			timeZone: entry.timeZone,
			nowMs: ctx.now,
			alertMinutes: policy.overtimeAlertMinutes,
			exempt: entry.overtimeExempt,
		})
		for (const alert of overtimeAlertFor(status)) {
			if (
				await enqueue(
					ctx.db,
					managerMessage(
						alert.kind,
						entry.staffId,
						entry.scopeId,
						dedupeKeys.overtime(
							alert.kind,
							entry.staffId,
							alert.scope,
							alert.periodKey,
						),
						{ scope: alert.scope, period: alert.periodKey },
					),
					ctx.now,
				)
			) {
				queued++
			}
		}
	}
	return { name: 'overtime', status: 'ok', queued }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const TIMECLOCK_STAFF_KINDS: readonly StaffOutboxKind[] = [
	'time_card_edited',
	'missed_clock_out_reminder',
	'auto_clock_out_notice',
]

/** The outbox kinds the organization's flags allow to be delivered right now. */
function deliverableKinds(features: StaffingFeatures): string[] {
	const kinds: string[] = []
	if (features.timeclock) {
		kinds.push(...TIMECLOCK_STAFF_KINDS)
		for (const kind of [
			'no_clock_in',
			'missed_clock_out',
			'auto_clock_out',
			'overtime_approaching',
			'overtime_reached',
		] as const) {
			kinds.push(managerOutboxKind(kind))
		}
	}
	if (features.scheduling) {
		kinds.push(
			'shift_reminder',
			'schedule_published',
			managerOutboxKind('schedule_published'),
		)
	}
	if (features.hiring) {
		kinds.push(
			managerOutboxKind('new_applicant'),
			managerOutboxKind('onboarding_due'),
			managerOutboxKind('certificate_expiring'),
		)
	}
	return kinds
}

async function markRow(
	db: StaffDb,
	row: NotificationOutboxRow,
	patch: Partial<typeof notificationOutbox.$inferInsert>,
) {
	await db
		.update(notificationOutbox)
		.set(patch)
		.where(
			and(
				eq(notificationOutbox.id, row.id),
				eq(notificationOutbox.status, 'pending'),
			),
		)
}

async function failOrRetry(
	db: StaffDb,
	row: NotificationOutboxRow,
	code: string,
	now: number,
	totals: DeliveryTotals,
) {
	const attempts = row.attempts + 1
	if (attempts >= OUTBOX_MAX_ATTEMPTS) {
		await markRow(db, row, { status: 'failed', attempts, lastError: code })
		totals.failed++
		return
	}
	await markRow(db, row, {
		attempts,
		lastError: code,
		nextAttemptAt: now + outboxRetryDelayMs(attempts),
	})
	totals.retry++
}

async function skipRow(
	db: StaffDb,
	row: NotificationOutboxRow,
	reason: string,
	totals: DeliveryTotals,
) {
	await markRow(db, row, { status: 'skipped', lastError: reason })
	totals.skipped++
}

function startAtOf(row: NotificationOutboxRow): number | null {
	const value = (row.payload as Record<string, unknown> | null)?.startAt
	return typeof value === 'number' ? value : null
}

/**
 * Of several queued schedule messages for the same person, scope and week
 * (two publications, or a resend), only the newest is sent: each one is built
 * from the live schedule, so the older ones would repeat it.
 */
function supersededScheduleRows(
	rows: readonly NotificationOutboxRow[],
): Set<string> {
	const newest = new Map<string, NotificationOutboxRow>()
	const keyOf = (row: NotificationOutboxRow) => {
		const payload = row.payload as Record<string, unknown> | null
		return `${row.staffId}|${row.scopeId ?? ''}|${String(payload?.weekStart ?? '')}`
	}
	const scheduleRows = rows.filter((row) => row.kind === 'schedule_published')
	for (const row of scheduleRows) {
		const key = keyOf(row)
		const current = newest.get(key)
		if (!current || row.createdAt >= current.createdAt) newest.set(key, row)
	}
	const out = new Set<string>()
	for (const row of scheduleRows) {
		if (newest.get(keyOf(row))!.id !== row.id) out.add(row.id)
	}
	return out
}

async function deliverStaffRows(
	ctx: TickContext,
	rows: NotificationOutboxRow[],
	contactLevel: 'full' | 'minimal',
	totals: DeliveryTotals,
) {
	const people = await loadStaff(ctx.db, [
		...new Set(rows.map((r) => r.staffId)),
	])
	const emailOn = ctx.deps.emailEnabled()
	let sent = 0
	const superseded = supersededScheduleRows(rows)
	for (const row of rows) {
		if (!isStaffOutboxKind(row.kind)) continue
		if (superseded.has(row.id)) {
			// A newer publication of the same week is queued for this person: one
			// email about the week is enough, and it shows the live schedule.
			await skipRow(ctx.db, row, 'superseded', totals)
			continue
		}
		if (
			isOutboxMessageStale({
				kind: row.kind,
				createdAt: row.createdAt,
				nowMs: ctx.now,
				startAt: startAtOf(row),
			})
		) {
			await skipRow(ctx.db, row, 'stale', totals)
			continue
		}
		const person = people.get(row.staffId)
		if (!person) {
			await skipRow(ctx.db, row, 'staff_missing', totals)
			continue
		}
		if (person.status !== 'active') {
			await skipRow(ctx.db, row, 'staff_inactive', totals)
			continue
		}
		if (!person.email) {
			await skipRow(ctx.db, row, 'no_email', totals)
			continue
		}
		// The kill switch drops the message rather than holding it: a reminder
		// sent hours after the switch is flipped back on is worse than none.
		if (!emailOn) {
			await skipRow(ctx.db, row, 'email_disabled', totals)
			continue
		}
		if (sent >= MAX_STAFF_EMAILS_PER_TICK) break

		const scope = row.scopeId
			? await ctx.deps.getScope(ctx.orgId, row.scopeId, ctx.now)
			: null
		const locale = normalizeStaffLocale(person.locale)
		let rendered: { subject: string; html: string; text: string }
		if (row.kind === 'schedule_published') {
			// Built from the live schedule: the person's own shifts and their link.
			try {
				const built = await buildScheduleNotice(ctx.db, {
					orgId: ctx.orgId,
					row,
					person,
					level: contactLevel,
					scope,
					now: ctx.now,
				})
				if (built.status === 'skip') {
					await skipRow(ctx.db, row, built.reason, totals)
					continue
				}
				rendered = built.mail
			} catch (error) {
				console.error(
					'Staff tick: building a schedule email failed',
					describeStaffError(error),
				)
				await failOrRetry(ctx.db, row, 'build_failed', ctx.now, totals)
				continue
			}
		} else {
			rendered = renderStaffEmail({
				kind: row.kind,
				level: contactLevel,
				locale,
				firstName:
					locale === 'ar' && person.firstNameAr
						? person.firstNameAr
						: person.firstName,
				scopeName: scope?.name ?? null,
				timeZone: scope?.timeZone ?? null,
				payload: (row.payload as Record<string, unknown> | null) ?? {},
			})
		}
		let outcome: Awaited<ReturnType<StaffEmailSender>>
		try {
			outcome = await ctx.deps.sendEmail({
				to: person.email,
				toName: `${person.firstName} ${person.lastName}`.trim(),
				subject: rendered.subject,
				html: rendered.html,
				text: rendered.text,
			})
		} catch {
			outcome = { status: 'error', error: { message: 'send_threw' } }
		}
		sent++
		if (outcome.status === 'error') {
			// The code only: a provider message can quote the address.
			const status = outcome.error.statusCode
			await failOrRetry(
				ctx.db,
				row,
				status ? `email_http_${status}` : 'email_error',
				ctx.now,
				totals,
			)
			continue
		}
		await markRow(ctx.db, row, {
			status: 'sent',
			sentAt: ctx.now,
			attempts: row.attempts + 1,
			lastError: null,
		})
		totals.sent++
	}
}

/** A stable id for the rows an alert covers: a retry carries the same one. */
export function managerEventId(dedupeKeysInGroup: readonly string[]): string {
	return createHash('sha256')
		.update([...dedupeKeysInGroup].sort().join('\n'))
		.digest('hex')
		.slice(0, 32)
}

/**
 * The one operator behind every row of a group, so the App can leave them out of
 * their own alert; nothing when the rows have different (or no) actors.
 */
function sharedActor(
	rows: readonly NotificationOutboxRow[],
): { actorUserId: string } | Record<string, never> {
	const actors = new Set(
		rows.map(
			(row) =>
				(row.payload as Record<string, unknown> | null)?.publishedBy ?? null,
		),
	)
	if (actors.size !== 1) return {}
	const [only] = [...actors]
	return typeof only === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(only)
		? { actorUserId: only }
		: {}
}

async function deliverManagerRows(
	ctx: TickContext,
	rows: NotificationOutboxRow[],
	totals: DeliveryTotals,
) {
	const groups = new Map<
		string,
		{
			kind: ManagerAlertKind
			scopeId: string | null
			rows: NotificationOutboxRow[]
		}
	>()
	for (const row of rows) {
		const kind = parseManagerOutboxKind(row.kind)
		if (!kind) continue
		if (
			isOutboxMessageStale({
				kind: row.kind,
				createdAt: row.createdAt,
				nowMs: ctx.now,
			})
		) {
			await skipRow(ctx.db, row, 'stale', totals)
			continue
		}
		const key = `${kind}|${row.scopeId ?? ''}`
		const group = groups.get(key) ?? {
			kind,
			scopeId: row.scopeId,
			rows: [],
		}
		group.rows.push(row)
		groups.set(key, group)
	}

	let delivered = 0
	for (const group of groups.values()) {
		if (delivered >= MAX_MANAGER_GROUPS_PER_TICK) break
		delivered++
		const event: ManagerAlertEvent = {
			orgId: ctx.orgId,
			eventId: managerEventId(group.rows.map((row) => row.dedupeKey)),
			kind: group.kind,
			scopeId: group.scopeId,
			count: Math.min(group.rows.length, 10_000),
			...sharedActor(group.rows),
		}
		const outcome = await ctx.deps.notifyManagers(event)
		for (const row of group.rows) {
			if (outcome.status === 'delivered') {
				if (outcome.result.skipped) {
					await skipRow(ctx.db, row, outcome.result.skipped, totals)
				} else {
					await markRow(ctx.db, row, {
						status: 'sent',
						sentAt: ctx.now,
						attempts: row.attempts + 1,
						lastError: null,
					})
					totals.sent++
				}
			} else if (outcome.status === 'rejected') {
				await markRow(ctx.db, row, {
					status: 'failed',
					attempts: row.attempts + 1,
					lastError: outcome.code,
				})
				totals.failed++
			} else {
				await failOrRetry(ctx.db, row, outcome.code, ctx.now, totals)
			}
		}
	}
}

async function deliverOutbox(
	ctx: TickContext,
	features: StaffingFeatures,
): Promise<{ staff: DeliveryTotals; managers: DeliveryTotals }> {
	const staff = emptyTotals()
	const managers = emptyTotals()
	const kinds = deliverableKinds(features)
	if (kinds.length === 0) return { staff, managers }

	const due = await ctx.db
		.select()
		.from(notificationOutbox)
		.where(
			and(
				eq(notificationOutbox.status, 'pending'),
				lte(notificationOutbox.nextAttemptAt, ctx.now),
				// bounded: a handful of notification kinds
				inArray(notificationOutbox.kind, kinds),
			),
		)
		.orderBy(asc(notificationOutbox.createdAt))
		.limit(DELIVERY_BATCH)
	if (due.length === 0) return { staff, managers }

	const staffRows = due.filter((row) => isStaffOutboxKind(row.kind))
	const managerRows = due.filter(
		(row) => parseManagerOutboxKind(row.kind) !== null,
	)
	if (staffRows.length > 0) {
		const settings = await getSettings(ctx.db)
		await deliverStaffRows(
			ctx,
			staffRows,
			normalizeContactLevel(settings.contactLevel),
			staff,
		)
	}
	if (managerRows.length > 0) {
		await deliverManagerRows(ctx, managerRows, managers)
	}
	return { staff, managers }
}

/**
 * A message nobody can deliver any more (its flag was switched off, so it is
 * never selected) must not stay pending for ever: it would keep the sub-hourly
 * timer alive and never be cleaned up. Past the longest relevance window it is
 * marked skipped, and finished rows are kept for a month (for support), then
 * dropped.
 */
async function purgeOutbox(db: StaffDb, now: number) {
	await db
		.delete(notificationOutbox)
		.where(
			and(
				inArray(notificationOutbox.status, ['sent', 'skipped', 'failed']),
				lte(notificationOutbox.createdAt, now - OUTBOX_RETENTION_MS),
			),
		)
	await db
		.update(notificationOutbox)
		.set({ status: 'skipped', lastError: 'stale' })
		.where(
			and(
				eq(notificationOutbox.status, 'pending'),
				lte(notificationOutbox.createdAt, now - MAX_PENDING_AGE_MS),
			),
		)
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

const inFlight = new Set<string>()

export type RunTickOptions = {
	db?: TenantDatabase
	deps?: Partial<TickDeps>
}

function skipped(
	orgId: string,
	at: number,
	reason: TickSkipReason,
): TickResult {
	return {
		orgId,
		status: 'skipped',
		reason,
		at,
		tasks: [],
		staffEmail: emptyTotals(),
		managerAlerts: emptyTotals(),
		needsFollowUp: false,
	}
}

async function guarded(
	name: string,
	run: () => Promise<TickTaskResult>,
): Promise<TickTaskResult> {
	try {
		return await run()
	} catch (error) {
		// A code and a root cause, never the query: drizzle quotes bound values.
		console.error(`Staff tick: ${name} failed`, describeStaffError(error))
		return { name, status: 'error', queued: 0, reason: 'task_failed' }
	}
}

export async function runStaffTickForOrg(
	orgId: string,
	options: RunTickOptions = {},
): Promise<TickResult> {
	const deps: TickDeps = { ...defaultTickDeps, ...options.deps }
	const now = deps.now()
	if (inFlight.has(orgId)) return skipped(orgId, now, 'busy')
	inFlight.add(orgId)
	try {
		let db: StaffDb
		try {
			db = options.db ?? (await getTenantDb(orgId))
		} catch {
			return skipped(orgId, now, 'no_database')
		}

		// Organizations without staff or applicants cost two local queries, and
		// never an App call. An organization hiring for its first job has
		// applicants (to tell managers about, and to purge later) before it has
		// staff.
		const [anyStaff] = await db
			.select({ n: sql<number>`1` })
			.from(staffMembers)
			.where(inArray(staffMembers.status, ['active', 'on_leave', 'invited']))
			.limit(1)
		if (!anyStaff) {
			const [anyApplicant] = await db
				.select({ n: sql<number>`1` })
				.from(hiringApplications)
				.limit(1)
			const [anyQueued] = anyApplicant
				? [anyApplicant]
				: await db
						.select({ n: sql<number>`1` })
						.from(notificationOutbox)
						.where(eq(notificationOutbox.status, 'pending'))
						.limit(1)
			if (!anyQueued) return skipped(orgId, now, 'no_staff')
		}

		const flags = await deps.getFeatures(orgId, now)
		if (!flags) return skipped(orgId, now, 'flags_unknown')
		if (!deps.regionMatches(flags.dataRegion)) {
			return skipped(orgId, now, 'region_mismatch')
		}
		const { features } = flags
		if (!features.enabled) return skipped(orgId, now, 'staffing_disabled')

		const ctx = new TickContext(orgId, db, now, deps)
		const tasks: TickTaskResult[] = []
		let open: OpenEntry[] = []
		let closedIds: Set<string> = new Set()
		let upcoming = 0

		if (features.timeclock) {
			try {
				open = await loadOpenEntries(db)
			} catch (error) {
				console.error(
					'Staff tick: reading open entries failed',
					describeStaffError(error),
				)
			}
			const auto = await guarded('auto_clock_out', async () => {
				const out = await autoClockOutTask(ctx, open)
				closedIds = out.closedIds
				return out.result
			})
			tasks.push(auto)
			tasks.push(
				await guarded('missed_clock_out', () =>
					missedClockOutTask(ctx, open, closedIds),
				),
			)
			tasks.push(
				await guarded('overtime', () => overtimeTask(ctx, open, closedIds)),
			)
			if (features.scheduling) {
				tasks.push(await guarded('no_clock_in', () => noClockInTask(ctx)))
			}
		}
		if (features.scheduling) {
			tasks.push(
				await guarded('pre_shift', async () => {
					const out = await preShiftTask(ctx)
					upcoming = out.upcoming
					return out.result
				}),
			)
		}

		// Declined applicants past their retention period are purged whatever the
		// hiring flag says: turning a module off must not keep personal data past
		// its period. Only declined rows are ever selected.
		tasks.push(
			await guarded('hiring_retention', async () => {
				const out = await purgeExpiredApplications(db, now)
				return {
					name: 'hiring_retention',
					status: 'ok',
					queued: 0,
					purged: out.purged,
				}
			}),
		)

		// Checklist reminders and certificate expiry alerts, behind their own flag.
		if (features.hiring) {
			tasks.push(
				await guarded('onboarding', async () => {
					const out = await runOnboardingTick({
						db,
						now,
						getScope: (scopeId) => deps.getScope(orgId, scopeId, now),
						enqueue: (message) => enqueue(db, message, now),
					})
					return { name: 'onboarding', status: 'ok', queued: out.queued }
				}),
			)
		}

		for (const task of deps.extraTasks()) {
			if (
				task.requires !== 'enabled' &&
				!features[task.requires as keyof StaffingFeatures]
			) {
				continue
			}
			tasks.push(
				await guarded(task.name, async () => {
					const out = await task.run({
						orgId,
						db,
						now,
						features,
						enqueue: (message) => enqueue(db, message, now),
					})
					return { name: task.name, status: 'ok', queued: out?.queued ?? 0 }
				}),
			)
		}

		let staffEmail = emptyTotals()
		let managerAlerts = emptyTotals()
		try {
			const delivered = await deliverOutbox(ctx, features)
			staffEmail = delivered.staff
			managerAlerts = delivered.managers
			await purgeOutbox(db, now)
		} catch (error) {
			console.error('Staff tick: delivery failed', describeStaffError(error))
		}

		let pending = 0
		try {
			// Only what this organization's flags let the tick deliver is worth
			// waking for.
			const kinds = deliverableKinds(features)
			if (kinds.length > 0) {
				const [row] = await db
					.select({ n: sql<number>`count(*)` })
					.from(notificationOutbox)
					.where(
						and(
							eq(notificationOutbox.status, 'pending'),
							// bounded: a handful of notification kinds
							inArray(notificationOutbox.kind, kinds),
						),
					)
				pending = Number(row?.n ?? 0)
			}
		} catch {
			pending = 0
		}

		// Entries just closed are no longer open; what remains is worth watching.
		const stillOpen = open.filter(
			(item) => !closedIds.has(item.entry.id),
		).length
		return {
			orgId,
			status: 'ran',
			at: now,
			tasks,
			staffEmail,
			managerAlerts,
			needsFollowUp: stillOpen > 0 || pending > 0 || upcoming > 0,
		}
	} finally {
		inFlight.delete(orgId)
	}
}

export type TickAggregate = {
	orgsRan: number
	orgsSkipped: number
	/** Organizations not reached before the deadline. */
	orgsDeferred: number
	queued: number
	closed: number
	staffEmailSent: number
	managerAlertsSent: number
	errors: number
}

export function emptyAggregate(): TickAggregate {
	return {
		orgsRan: 0,
		orgsSkipped: 0,
		orgsDeferred: 0,
		queued: 0,
		closed: 0,
		staffEmailSent: 0,
		managerAlertsSent: 0,
		errors: 0,
	}
}

export function addToAggregate(total: TickAggregate, result: TickResult) {
	if (result.status === 'skipped') {
		total.orgsSkipped++
		return
	}
	total.orgsRan++
	for (const task of result.tasks) {
		total.queued += task.queued
		total.closed += task.closed ?? 0
		if (task.status === 'error') total.errors++
	}
	total.staffEmailSent += result.staffEmail.sent
	total.managerAlertsSent += result.managerAlerts.sent
}

/** Test seam: forget which organizations are mid-tick. */
export function resetTickLocks() {
	inFlight.clear()
}
