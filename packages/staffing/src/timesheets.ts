import { z } from 'zod'
import { splitWeeklyThreshold } from './hours.ts'
import {
	addDays,
	daysBetween,
	localDateSchema,
	localTimeSchema,
	minutesBetween,
	startOfWeek,
	type WeekStart,
	zonedWallTimeToUtc,
} from './time.ts'

const id = z.string().trim().min(1).max(64)

/** An entry open longer than this is flagged as a missing clock-out. */
export const MISSING_CLOCK_OUT_HOURS = 12
export const TIMESHEET_MAX_DAYS = 31

export const timesheetQuerySchema = z
	.object({
		locationId: id,
		from: localDateSchema,
		/** Inclusive. */
		to: localDateSchema,
	})
	.refine(
		(query) =>
			daysBetween(query.from, query.to) >= 0 &&
			daysBetween(query.from, query.to) < TIMESHEET_MAX_DAYS,
		{ message: 'invalid_range', path: ['to'] },
	)

const reasonSchema = z.string().trim().min(1).max(500)

/**
 * Times are the location's wall clock on `localDate`. A clock-out at or
 * before the clock-in is the next day; `null` leaves the card open.
 */
const entryFields = {
	positionId: id.nullable(),
	localDate: localDateSchema,
	clockIn: localTimeSchema,
	clockOut: localTimeSchema.nullable(),
	unpaidBreakMinutes: z.number().int().min(0).max(480).default(0),
	note: z.string().trim().max(500).default(''),
}

export const timeEntryCreateSchema = z.object({
	locationId: id,
	staffId: id,
	...entryFields,
	reason: z.string().trim().max(500).default(''),
})
export type TimeEntryCreateInput = z.infer<typeof timeEntryCreateSchema>

export const timeEntryUpdateSchema = z.object({
	...entryFields,
	reason: reasonSchema,
})
export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>

export const timeEntryDeleteSchema = z.object({ reason: reasonSchema })
export const timeEntryReopenSchema = z.object({ reason: reasonSchema })

export const timeEntryApproveSchema = z.object({
	locationId: id,
	entryIds: z.array(id).min(1).max(500),
})

/** Resolves manager-entered wall-clock times to instants in the location zone. */
export function timeEntryInstants(
	input: Pick<TimeEntryUpdateInput, 'localDate' | 'clockIn' | 'clockOut'>,
	timeZone: string,
) {
	const clockInAt = zonedWallTimeToUtc(input.localDate, input.clockIn, timeZone)
	if (input.clockOut === null) return { clockInAt, clockOutAt: null }
	const overnight = input.clockOut <= input.clockIn
	const clockOutAt = zonedWallTimeToUtc(
		overnight ? addDays(input.localDate, 1) : input.localDate,
		input.clockOut,
		timeZone,
	)
	return { clockInAt, clockOutAt }
}

export function entryPaidMinutes(entry: {
	clockInAt: Date
	clockOutAt: Date | null
	unpaidBreakMinutes: number
}) {
	if (!entry.clockOutAt) return 0
	return Math.max(
		0,
		minutesBetween(entry.clockInAt, entry.clockOutAt) -
			entry.unpaidBreakMinutes,
	)
}

export type TimeEntryIssue = 'missing_clock_out' | 'unscheduled' | 'late'

/**
 * Review flags, not rules: managers can still approve a late or unscheduled
 * card. Only a missing clock-out blocks approval.
 */
export function timeEntryIssues(
	entry: { clockInAt: Date; clockOutAt: Date | null },
	scheduled: { startAt: Date } | null,
	options: { lateGraceMinutes: number; now: Date },
): TimeEntryIssue[] {
	const issues: TimeEntryIssue[] = []
	if (
		!entry.clockOutAt &&
		options.now.getTime() - entry.clockInAt.getTime() >
			MISSING_CLOCK_OUT_HOURS * 3_600_000
	) {
		issues.push('missing_clock_out')
	}
	if (!scheduled) issues.push('unscheduled')
	else if (
		entry.clockInAt.getTime() >
		scheduled.startAt.getTime() + options.lateGraceMinutes * 60_000
	) {
		issues.push('late')
	}
	return issues
}

/**
 * Paid minutes per person per week, split at the organization's weekly hours
 * setting. Weeks follow the configured week start; this is an export column
 * and a warning, not an overtime pay calculation.
 */
export function weeklyTotals(
	entries: readonly {
		staffId: string
		localDate: string
		paidMinutes: number
	}[],
	options: { weekStart: WeekStart; weeklyHoursThreshold: number | null },
) {
	const totals = new Map<string, number>()
	for (const entry of entries) {
		const key = `${entry.staffId}|${startOfWeek(entry.localDate, options.weekStart)}`
		totals.set(key, (totals.get(key) ?? 0) + entry.paidMinutes)
	}
	return [...totals].map(([key, paidMinutes]) => {
		const [staffId, weekStart] = key.split('|') as [string, string]
		return {
			staffId,
			weekStart,
			paidMinutes,
			...splitWeeklyThreshold(paidMinutes, options.weeklyHoursThreshold),
		}
	})
}
