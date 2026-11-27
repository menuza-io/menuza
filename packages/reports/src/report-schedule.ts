import {
	addDays,
	dayOfWeek,
	formatDate,
	isValidTimeZone,
	localParts,
	zonedLocalToUtc,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Rules of a scheduled report email (#121). Pure, shared by the App (which
 * decides what is due and who may receive it) and tests. The region runs the
 * report and sends the email; nothing here touches data.
 */

export const REPORT_SCHEDULE_CADENCES = ['daily', 'weekly', 'monthly'] as const
export type ReportScheduleCadence = (typeof REPORT_SCHEDULE_CADENCES)[number]

/** The ready-made schedule that has no saved report behind it. */
export const DAILY_SUMMARY_BUILT_IN = 'daily_summary' as const

export const REPORT_SCHEDULE_LIMITS = {
	schedulesPerOrganization: 10,
	recipientsPerSchedule: 20,
} as const

/** Three failed days in a row pause a schedule and tell its owner. */
export const REPORT_SCHEDULE_FAILED_DAYS_TO_PAUSE = 3

/**
 * A failed send is tried again twice (3 attempts a day), the first after 30
 * minutes and the second after 2 hours, then the error is recorded. The
 * hourly job picks each retry up on its next tick.
 */
export const REPORT_SEND_RETRY_BACKOFF_MS = [
	30 * 60_000,
	2 * 3_600_000,
] as const

/**
 * A tick that missed the chosen hour (the job was down) still sends within
 * this many hours; later than that, the day is skipped rather than sending
 * "yesterday's numbers" in the afternoon.
 */
export const REPORT_SEND_CATCH_UP_HOURS = 6

export const reportScheduleInputSchema = z
	.object({
		cadence: z.enum(REPORT_SCHEDULE_CADENCES),
		/** 0 = Sunday ... 6 = Saturday; only for weekly. */
		weekday: z.number().int().min(0).max(6).nullable().default(null),
		hour: z.number().int().min(0).max(23),
		timeZone: z
			.string()
			.min(1)
			.max(64)
			.refine(isValidTimeZone, 'invalid_time_zone'),
	})
	.refine((value) => value.cadence !== 'weekly' || value.weekday !== null, {
		message: 'weekday_required',
		path: ['weekday'],
	})
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>

export type ScheduleTiming = {
	cadence: ReportScheduleCadence
	weekday: number | null
	hour: number
	timeZone: string
	createdAt: Date
}

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function localDateKey(now: Date, timeZone: string): string {
	const p = localParts(now.getTime(), timeZone)
	return formatDate(p.year, p.month, p.day)
}

function runsOn(timing: ScheduleTiming, dateKey: string): boolean {
	if (timing.cadence === 'daily') return true
	if (timing.cadence === 'weekly') return dayOfWeek(dateKey) === timing.weekday
	return dateKey.endsWith('-01')
}

/**
 * The local date a send is due for at `now`, or null when none is: the
 * cadence matches today in the schedule's zone, the chosen hour has come (and
 * is not more than the catch-up window past), and the scheduled moment is not
 * before the schedule existed (a schedule made at 15:00 for 08:00 first runs
 * tomorrow). The key is the run's identity: one send per key.
 */
export function dueRunKey(timing: ScheduleTiming, now: Date): string | null {
	const p = localParts(now.getTime(), timing.timeZone)
	const dateKey = formatDate(p.year, p.month, p.day)
	if (!runsOn(timing, dateKey)) return null
	if (p.hour < timing.hour) return null
	if (p.hour >= timing.hour + REPORT_SEND_CATCH_UP_HOURS) return null
	const scheduledAt = zonedLocalToUtc(
		p.year,
		p.month,
		p.day,
		timing.hour,
		0,
		timing.timeZone,
	)
	if (scheduledAt < timing.createdAt.getTime()) return null
	return dateKey
}

export function nextRetryAt(attempt: number, now: Date): Date | null {
	const wait = REPORT_SEND_RETRY_BACKOFF_MS[attempt]
	return wait === undefined ? null : new Date(now.getTime() + wait)
}

/** The local date `days` before a `YYYY-MM-DD` key. */
export function shiftDateKey(key: string, days: number): string {
	return addDays(key, days)
}
