import { z } from 'zod'
import { opaqueIdSchema } from './internal-api.ts'
import { STAFFING_PERMISSIONS, type StaffingPermission } from './permissions.ts'
import { type LaborRules } from './rules.ts'
import {
	computeWeek,
	type TimeBreak,
	type TimeEntryInput,
} from './time-math.ts'
import { businessDateOf, weekStartFor } from './tz.ts'

/**
 * Clock operations: the alerts and reminders the regional tick sends around the
 * time clock. Everything here is pure and takes the clock as an argument, so a
 * tick is a function of (data, now) and can be tested with a fixed instant.
 *
 * Two audiences, two routes (ADR 047, decision 4):
 *
 * - Staff are told by tenant-api, which holds their contact data. Nothing about
 *   them leaves the region.
 * - Managers are told by the App, which holds their email and preferences. The
 *   only thing that crosses is a generic event: the organization, the kind of
 *   alert, a scope id and a count. Never a staff id, a name, a time or a pay
 *   figure. The strict schema below is that rule in code.
 */

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE

// ---------------------------------------------------------------------------
// Manager alerts (tenant-api -> App)
// ---------------------------------------------------------------------------

export const MANAGER_ALERT_KINDS = [
	'no_clock_in',
	'missed_clock_out',
	'auto_clock_out',
	'overtime_approaching',
	'overtime_reached',
	'schedule_published',
	'new_applicant',
	'onboarding_due',
	'certificate_expiring',
] as const
export type ManagerAlertKind = (typeof MANAGER_ALERT_KINDS)[number]

export function isManagerAlertKind(value: unknown): value is ManagerAlertKind {
	return (
		typeof value === 'string' &&
		(MANAGER_ALERT_KINDS as readonly string[]).includes(value)
	)
}

/** The App route that turns an alert into notifications. */
export const STAFFING_NOTIFY_PATH = '/resources/staffing/notify'

/**
 * The whole payload of a manager alert. `.strict()` makes any extra field (a
 * name, a time, a staff id) a 400 rather than something quietly carried along.
 * `eventId` is derived from the rows the alert covers, so a retried delivery
 * carries the same id and the App can tell it already handled it.
 */
export const managerAlertEventSchema = z
	.object({
		orgId: opaqueIdSchema,
		eventId: z.string().regex(/^[a-f0-9]{16,64}$/, 'Invalid event id'),
		kind: z.enum(MANAGER_ALERT_KINDS),
		scopeId: opaqueIdSchema.nullable(),
		count: z.number().int().min(1).max(10_000),
		/**
		 * The operator whose action raised it (an opaque control-plane user id,
		 * never staff data), so the App can leave them out of their own alert.
		 */
		actorUserId: opaqueIdSchema.optional(),
	})
	.strict()
export type ManagerAlertEvent = z.infer<typeof managerAlertEventSchema>

/** What the App answers: counts only. */
export const managerAlertResultSchema = z
	.object({
		inApp: z.number().int().nonnegative(),
		emailed: z.number().int().nonnegative(),
		/** Why nothing was delivered (flag off, no recipients), when so. */
		skipped: z.string().max(64).optional(),
	})
	.strict()
export type ManagerAlertResult = z.infer<typeof managerAlertResultSchema>

/** Notification preference workflows (one row per member in the App). */
export const STAFFING_NOTIFICATION_WORKFLOWS = [
	'staffing-attendance-workflow',
	'staffing-overtime-workflow',
	'staffing-schedule-workflow',
	'staffing-hiring-workflow',
] as const
export type StaffingNotificationWorkflow =
	(typeof STAFFING_NOTIFICATION_WORKFLOWS)[number]

export function isStaffingNotificationWorkflow(
	value: unknown,
): value is StaffingNotificationWorkflow {
	return (
		typeof value === 'string' &&
		(STAFFING_NOTIFICATION_WORKFLOWS as readonly string[]).includes(value)
	)
}

export const MANAGER_ALERT_WORKFLOW: Record<
	ManagerAlertKind,
	StaffingNotificationWorkflow
> = {
	no_clock_in: 'staffing-attendance-workflow',
	missed_clock_out: 'staffing-attendance-workflow',
	auto_clock_out: 'staffing-attendance-workflow',
	overtime_approaching: 'staffing-overtime-workflow',
	overtime_reached: 'staffing-overtime-workflow',
	schedule_published: 'staffing-schedule-workflow',
	new_applicant: 'staffing-hiring-workflow',
	onboarding_due: 'staffing-hiring-workflow',
	certificate_expiring: 'staffing-hiring-workflow',
}

/** `Notification.type` written for each alert. Always starts `staffing-`. */
export const MANAGER_ALERT_NOTIFICATION_TYPE: Record<
	ManagerAlertKind,
	`staffing-${string}`
> = {
	no_clock_in: 'staffing-no-clock-in',
	missed_clock_out: 'staffing-missed-clock-out',
	auto_clock_out: 'staffing-auto-clock-out',
	overtime_approaching: 'staffing-overtime-approaching',
	overtime_reached: 'staffing-overtime-reached',
	schedule_published: 'staffing-schedule-published',
	new_applicant: 'staffing-new-applicant',
	onboarding_due: 'staffing-onboarding-due',
	certificate_expiring: 'staffing-certificate-expiring',
}

export const STAFFING_NOTIFICATION_TYPE_PREFIX = 'staffing-'

export function managerAlertKindFromNotificationType(
	type: unknown,
): ManagerAlertKind | null {
	if (typeof type !== 'string') return null
	const found = (
		Object.entries(MANAGER_ALERT_NOTIFICATION_TYPE) as Array<
			[ManagerAlertKind, string]
		>
	).find(([, value]) => value === type)
	return found ? found[0] : null
}

/**
 * Who may be told: members holding one of these grants (a stronger grant counts)
 * and whose scope scope covers the alert's scope. The recipient has to be
 * able to open what the alert points at, which is the Today screen and the
 * timesheets, both behind `read:timesheet:any`.
 */
export const MANAGER_ALERT_PERMISSIONS: Record<
	ManagerAlertKind,
	readonly StaffingPermission[]
> = {
	no_clock_in: [STAFFING_PERMISSIONS.READ_TIMESHEET],
	missed_clock_out: [STAFFING_PERMISSIONS.READ_TIMESHEET],
	auto_clock_out: [STAFFING_PERMISSIONS.READ_TIMESHEET],
	overtime_approaching: [STAFFING_PERMISSIONS.READ_TIMESHEET],
	overtime_reached: [STAFFING_PERMISSIONS.READ_TIMESHEET],
	// Told to the people who can open the schedule it points at.
	schedule_published: [STAFFING_PERMISSIONS.READ_SCHEDULE],
	// Told to the people who can open the applicants it points at.
	new_applicant: [STAFFING_PERMISSIONS.READ_HIRING],
	// Told to the people who can open the checklists and certificates.
	onboarding_due: [STAFFING_PERMISSIONS.READ_HIRING],
	certificate_expiring: [STAFFING_PERMISSIONS.READ_HIRING],
}

/** Where an alert opens, relative to the organization's Staff section. */
export function managerAlertPath(
	kind: ManagerAlertKind,
	scopeId: string | null,
): string {
	const base =
		kind === 'no_clock_in'
			? '/staff/timeclock'
			: kind === 'schedule_published'
				? '/staff/schedule'
				: kind === 'new_applicant'
					? '/staff/hiring/applicants'
					: kind === 'onboarding_due' || kind === 'certificate_expiring'
						? '/staff/team'
						: '/staff/timeclock/timesheets'
	if (kind === 'no_clock_in' || !scopeId) return base
	return `${base}?${new URLSearchParams({ scope: scopeId })}`
}

// ---------------------------------------------------------------------------
// Outbox kinds and keys (regional notification_outbox)
// ---------------------------------------------------------------------------

/** Messages to a staff member, sent by tenant-api. */
export const STAFF_OUTBOX_KINDS = [
	'time_card_edited',
	'shift_reminder',
	'missed_clock_out_reminder',
	'auto_clock_out_notice',
	'schedule_published',
] as const
export type StaffOutboxKind = (typeof STAFF_OUTBOX_KINDS)[number]

export function isStaffOutboxKind(value: unknown): value is StaffOutboxKind {
	return (
		typeof value === 'string' &&
		(STAFF_OUTBOX_KINDS as readonly string[]).includes(value)
	)
}

export const MANAGER_OUTBOX_PREFIX = 'manager.'

export function managerOutboxKind(kind: ManagerAlertKind): string {
	return `${MANAGER_OUTBOX_PREFIX}${kind}`
}

/** The alert kind of a `manager.*` outbox row, or `null` for anything else. */
export function parseManagerOutboxKind(
	value: unknown,
): ManagerAlertKind | null {
	if (typeof value !== 'string' || !value.startsWith(MANAGER_OUTBOX_PREFIX)) {
		return null
	}
	const kind = value.slice(MANAGER_OUTBOX_PREFIX.length)
	return isManagerAlertKind(kind) ? kind : null
}

/**
 * Dedupe keys. The outbox has a unique index on the key, so a tick that runs
 * twice (or an alarm racing the hourly cron) queues each message once.
 */
export const dedupeKeys = {
	shiftReminder: (shiftId: string, staffId: string) =>
		`shift_reminder:${shiftId}:${staffId}`,
	missedClockOutReminder: (entryId: string) =>
		`missed_clock_out_reminder:${entryId}`,
	autoClockOutNotice: (entryId: string) => `auto_clock_out_notice:${entryId}`,
	noClockIn: (shiftId: string, staffId: string) =>
		`${MANAGER_OUTBOX_PREFIX}no_clock_in:${shiftId}:${staffId}`,
	missedClockOut: (entryId: string) =>
		`${MANAGER_OUTBOX_PREFIX}missed_clock_out:${entryId}`,
	autoClockOut: (entryId: string) =>
		`${MANAGER_OUTBOX_PREFIX}auto_clock_out:${entryId}`,
	schedulePublishedManagers: (publicationId: string) =>
		`${MANAGER_OUTBOX_PREFIX}schedule_published:${publicationId}`,
	newApplicant: (applicationId: string) =>
		`${MANAGER_OUTBOX_PREFIX}new_applicant:${applicationId}`,
	/**
	 * One row per task and stage, so a manager alert's count is the number of
	 * tasks. The due date is part of the key: a postponed task reminds again.
	 */
	onboardingDue: (taskId: string, stage: 1 | 2, dueDate: string) =>
		`${MANAGER_OUTBOX_PREFIX}onboarding_due:${taskId}:${stage}:${dueDate}`,
	/** One row per certificate, stage and expiry date (a renewal starts over). */
	certificateExpiring: (
		certificateId: string,
		stage: 1 | 2,
		expiresOn: string,
	) =>
		`${MANAGER_OUTBOX_PREFIX}certificate_expiring:${certificateId}:${stage}:${expiresOn}`,
	overtime: (
		kind: 'overtime_approaching' | 'overtime_reached',
		staffId: string,
		scope: 'week' | 'day',
		periodKey: string,
	) =>
		`${MANAGER_OUTBOX_PREFIX}${kind}:${staffId}:${scope === 'week' ? 'w' : 'd'}:${periodKey}`,
}

export const OUTBOX_MAX_ATTEMPTS = 8
const OUTBOX_RETRY_BASE_MS = 5 * MS_PER_MINUTE
const OUTBOX_RETRY_MAX_MS = 6 * MS_PER_HOUR

/** 5 minutes, 10, 20, 40, ... capped at 6 hours. `attempts` is the number made. */
export function outboxRetryDelayMs(attempts: number): number {
	const exponent = Math.max(0, Math.min(attempts - 1, 12))
	return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** exponent, OUTBOX_RETRY_MAX_MS)
}

/** How long after it was queued a message is still worth sending. */
export const OUTBOX_RELEVANCE_MS = {
	time_card_edited: 7 * 24 * MS_PER_HOUR,
	shift_reminder: 12 * MS_PER_HOUR,
	missed_clock_out_reminder: 24 * MS_PER_HOUR,
	auto_clock_out_notice: 24 * MS_PER_HOUR,
	schedule_published: 7 * 24 * MS_PER_HOUR,
	manager: 24 * MS_PER_HOUR,
} as const

/**
 * A message that waited too long is dropped rather than sent: a "your shift
 * starts at 5" reminder after 5 is noise, and so is yesterday's alert.
 */
export function isOutboxMessageStale(input: {
	kind: string
	createdAt: number
	nowMs: number
	/** For a shift reminder: when the shift starts. */
	startAt?: number | null
}): boolean {
	const { kind, createdAt, nowMs } = input
	if (kind === 'shift_reminder' && typeof input.startAt === 'number') {
		if (nowMs >= input.startAt) return true
	}
	const window = isStaffOutboxKind(kind)
		? OUTBOX_RELEVANCE_MS[kind]
		: OUTBOX_RELEVANCE_MS.manager
	return nowMs - createdAt > window
}

// ---------------------------------------------------------------------------
// Timing rules
// ---------------------------------------------------------------------------

/**
 * When a person with no scheduled shift is expected to be done. Without a
 * schedule there is no end to measure a reminder or an automatic clock-out
 * from, and measuring from clock-in would remind everyone minutes after they
 * start. The long-shift threshold is the point at which the card is already
 * flagged for review, so it is the honest "this has gone on too long" mark.
 */
export function expectedEntryEnd(input: {
	clockInAt: number
	shiftEndAt: number | null
	longShiftMinutes: number
}): number {
	if (input.shiftEndAt !== null && input.shiftEndAt > input.clockInAt) {
		return input.shiftEndAt
	}
	return input.clockInAt + input.longShiftMinutes * MS_PER_MINUTE
}

/** The instant an automatic clock-out records: the shift end, else the due time. */
export function autoClockOutInstant(input: {
	clockInAt: number
	shiftEndAt: number | null
	dueAt: number
	openBreakStartAt: number | null
	nowMs: number
}): number {
	const base =
		input.shiftEndAt !== null && input.shiftEndAt > input.clockInAt
			? input.shiftEndAt
			: input.dueAt
	// Never before the person's open break began, and never in the future.
	const atLeastBreak = Math.max(base, input.openBreakStartAt ?? 0)
	return Math.min(Math.max(atLeastBreak, input.clockInAt), input.nowMs)
}

/** Whether a scheduled person is overdue to clock in (alert managers). */
export function isNoClockInDue(input: {
	shiftStartAt: number
	shiftEndAt: number
	alertMinutes: number | null
	nowMs: number
}): boolean {
	if (input.alertMinutes === null) return false
	const dueAt = input.shiftStartAt + input.alertMinutes * MS_PER_MINUTE
	return input.nowMs >= dueAt && input.nowMs < input.shiftEndAt
}

/** Whether a pre-shift reminder should go out now (and the shift has not begun). */
export function isPreShiftReminderDue(input: {
	shiftStartAt: number
	reminderMinutes: number | null
	nowMs: number
}): boolean {
	if (input.reminderMinutes === null) return false
	return (
		input.nowMs >= input.shiftStartAt - input.reminderMinutes * MS_PER_MINUTE &&
		input.nowMs < input.shiftStartAt
	)
}

/** The longest lookback the schedule is asked for when scanning for late arrivals. */
export const NO_CLOCK_IN_LOOKBACK_MS = 12 * MS_PER_HOUR
/** The longest lead a pre-shift reminder can have (the policy maximum). */
export const PRE_SHIFT_MAX_LEAD_MS = 48 * MS_PER_HOUR

// ---------------------------------------------------------------------------
// Overtime proximity
// ---------------------------------------------------------------------------

export type OvertimeProximity = 'none' | 'approaching' | 'reached'

export type OvertimeStatus = {
	weekly: OvertimeProximity
	daily: OvertimeProximity
	/** Counted minutes toward the weekly threshold (null: no weekly rule). */
	weeklyMinutes: number | null
	dailyMinutes: number | null
	weekStartDate: string
	localDate: string
}

function proximity(
	worked: number,
	threshold: number | null,
	alertMinutes: number,
): OvertimeProximity {
	if (threshold === null) return 'none'
	if (worked >= threshold) return 'reached'
	return worked >= threshold - alertMinutes ? 'approaching' : 'none'
}

/**
 * Where a person stands against the overtime thresholds right now. The week is
 * computed with the shared time math (an open entry counts up to `nowMs`), so
 * this can never disagree with a timesheet. With overtime counted per scope,
 * only that scope's entries are measured, exactly as the timesheet does.
 * Exempt staff never accrue overtime, so they never alert.
 */
export function overtimeStatus(input: {
	entries: ReadonlyArray<TimeEntryInput & { breaks?: readonly TimeBreak[] }>
	/** The scope of the entry the person is working on now. */
	scopeId: string
	rules: LaborRules
	timeZone: string
	nowMs: number
	alertMinutes: number
	exempt: boolean
}): OvertimeStatus {
	const { rules, nowMs } = input
	const localDate = businessDateOf(
		nowMs,
		input.timeZone,
		rules.workdayStartMinute,
	)
	const weekStartDate = weekStartFor(localDate, rules.weekStartsOn)
	const none: OvertimeStatus = {
		weekly: 'none',
		daily: 'none',
		weeklyMinutes: null,
		dailyMinutes: null,
		weekStartDate,
		localDate,
	}
	if (input.exempt) return none
	const weeklyThreshold = rules.weeklyOvertime?.thresholdMinutes ?? null
	const dailyThreshold = rules.dailyOvertime?.thresholdMinutes ?? null
	if (weeklyThreshold === null && dailyThreshold === null) return none

	const scoped = rules.aggregateOvertimeAcrossScopes
		? input.entries
		: input.entries.filter((entry) => entry.scopeId === input.scopeId)
	const summary = computeWeek(scoped, rules, {
		timeZone: input.timeZone,
		nowMs,
		weekStartDate,
	})
	// Holiday time counts toward no threshold.
	const counted = (b: {
		regular: number
		overtime: number
		doubleTime: number
	}) => b.regular + b.overtime + b.doubleTime
	const weeklyMinutes = counted(summary)
	const today = summary.days.find((day) => day.date === localDate)
	const dailyMinutes = today ? counted(today) : 0

	return {
		weekly: proximity(weeklyMinutes, weeklyThreshold, input.alertMinutes),
		daily: proximity(dailyMinutes, dailyThreshold, input.alertMinutes),
		weeklyMinutes: weeklyThreshold === null ? null : weeklyMinutes,
		dailyMinutes: dailyThreshold === null ? null : dailyMinutes,
		weekStartDate,
		localDate,
	}
}

/**
 * The single most urgent overtime alert for a status, with the period it
 * belongs to (the dedupe scope): reached beats approaching, weekly beats daily.
 */
export function overtimeAlertFor(status: OvertimeStatus): {
	kind: 'overtime_approaching' | 'overtime_reached'
	scope: 'week' | 'day'
	periodKey: string
}[] {
	const alerts: ReturnType<typeof overtimeAlertFor> = []
	if (status.weekly === 'reached') {
		alerts.push({
			kind: 'overtime_reached',
			scope: 'week',
			periodKey: status.weekStartDate,
		})
	} else if (status.weekly === 'approaching') {
		alerts.push({
			kind: 'overtime_approaching',
			scope: 'week',
			periodKey: status.weekStartDate,
		})
	}
	if (status.daily === 'reached') {
		alerts.push({
			kind: 'overtime_reached',
			scope: 'day',
			periodKey: status.localDate,
		})
	} else if (status.daily === 'approaching') {
		alerts.push({
			kind: 'overtime_approaching',
			scope: 'day',
			periodKey: status.localDate,
		})
	}
	return alerts
}

// ---------------------------------------------------------------------------
// Staff message content level
// ---------------------------------------------------------------------------

/**
 * How much a staff email says. `full` names the scope and the times;
 * `minimal` is a generic line with none of that (the default for Saudi
 * organizations, where less in an inbox is the safer default).
 */
export type ContactLevel = 'full' | 'minimal'

export function normalizeContactLevel(value: unknown): ContactLevel {
	// Anything unrecognized falls to the one that says less.
	return value === 'full' ? 'full' : 'minimal'
}

/** Whether the email kill switch value means "send". Unset means enabled. */
export function isEmailSwitchOn(raw: unknown): boolean {
	const value = String(raw ?? '')
		.trim()
		.toLowerCase()
	return !['false', '0', 'off', 'no', 'disabled'].includes(value)
}
