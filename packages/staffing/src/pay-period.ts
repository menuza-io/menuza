import { z } from 'zod'
import { localDateSchema } from './schemas.ts'
import {
	addDays,
	daysBetween,
	formatDate,
	parseDate,
	weekStartFor,
} from './tz.ts'

/**
 * Pay periods: which range of business dates a timesheet covers. A period is a
 * pure function of a date, the organization's period type, an optional anchor
 * date, and (for the built-in anchor) the week start. Nothing here reads a
 * clock or a database, and nothing asserts a legal pay schedule: it only draws
 * the boundaries a payroll file is cut on.
 *
 *  - weekly, biweekly: periods of 7 or 14 days counted from the anchor date.
 *    With no anchor, weekly follows the workweek and biweekly pairs workweeks
 *    from a fixed Monday-based epoch so every client agrees.
 *  - semimonthly: two periods a month, starting on day D and day D + 15 of the
 *    anchor's day-of-month D (1-14). D = 1 gives the 1st-15th and 16th-end.
 *  - monthly: one period a month starting on the anchor's day-of-month D (1-28).
 */
export const PAY_PERIOD_TYPES = [
	'weekly',
	'biweekly',
	'semimonthly',
	'monthly',
] as const
export type PayPeriodType = (typeof PAY_PERIOD_TYPES)[number]

/** A Monday. Keeps the unanchored biweekly cadence stable for everyone. */
export const BUILTIN_PAY_PERIOD_EPOCH = '2024-01-01'

export type PayPeriodConfig = {
	type: PayPeriodType
	/** A date that fixes the cadence; null uses the built-in. */
	anchor: string | null
	/** Workweek start, used only when there is no anchor. 0 = Sunday. */
	weekStartsOn?: number
}

export type PayPeriod = {
	type: PayPeriodType
	/** First business date, inclusive. */
	start: string
	/** Last business date, inclusive. */
	end: string
	days: number
}

export const MAX_SEMIMONTHLY_ANCHOR_DAY = 14
export const MAX_MONTHLY_ANCHOR_DAY = 28

export type PayPeriodProblem = 'anchor_day_unsupported'

/**
 * Why an anchor cannot be used with a period type, or null when it can. A
 * semimonthly anchor must fall on day 1-14 and a monthly one on day 1-28 so
 * that every month has the boundary dates.
 */
export function payPeriodAnchorProblem(
	type: PayPeriodType,
	anchor: string | null,
): PayPeriodProblem | null {
	if (anchor === null) return null
	const { day } = parseDate(anchor)
	if (type === 'semimonthly' && day > MAX_SEMIMONTHLY_ANCHOR_DAY) {
		return 'anchor_day_unsupported'
	}
	if (type === 'monthly' && day > MAX_MONTHLY_ANCHOR_DAY) {
		return 'anchor_day_unsupported'
	}
	return null
}

export const payPeriodSettingsSchema = z
	.object({
		payPeriod: z.enum(PAY_PERIOD_TYPES),
		payPeriodAnchor: localDateSchema.nullable(),
	})
	.strict()
export type PayPeriodSettings = z.infer<typeof payPeriodSettingsSchema>

function shiftMonth(
	year: number,
	month: number,
	delta: number,
): { year: number; month: number } {
	const index = year * 12 + (month - 1) + delta
	return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function monthDate(
	year: number,
	month: number,
	delta: number,
	day: number,
): string {
	const target = shiftMonth(year, month, delta)
	return formatDate(target.year, target.month, day)
}

function dayOfMonthAnchor(
	type: 'semimonthly' | 'monthly',
	anchor: string | null,
): number {
	if (anchor === null || payPeriodAnchorProblem(type, anchor)) return 1
	return parseDate(anchor).day
}

function lengthDays(start: string, end: string): number {
	return daysBetween(start, end) + 1
}

/** The pay period that contains `date`. Total: a bad anchor falls back to the default. */
export function payPeriodFor(date: string, config: PayPeriodConfig): PayPeriod {
	const { type } = config
	if (type === 'weekly' || type === 'biweekly') {
		const length = type === 'weekly' ? 7 : 14
		const weekStartsOn = config.weekStartsOn ?? 1
		const anchor =
			config.anchor ??
			(type === 'weekly'
				? weekStartFor(date, weekStartsOn)
				: weekStartFor(BUILTIN_PAY_PERIOD_EPOCH, weekStartsOn))
		const index = Math.floor(daysBetween(anchor, date) / length)
		const start = addDays(anchor, index * length)
		return { type, start, end: addDays(start, length - 1), days: length }
	}

	const { year, month, day } = parseDate(date)
	const anchorDay = dayOfMonthAnchor(type, config.anchor)

	if (type === 'monthly') {
		const startDelta = day >= anchorDay ? 0 : -1
		const start = monthDate(year, month, startDelta, anchorDay)
		const end = addDays(monthDate(year, month, startDelta + 1, anchorDay), -1)
		return { type, start, end, days: lengthDays(start, end) }
	}

	// Semimonthly: boundaries on day D and day D + 15 of each month.
	const second = anchorDay + 15
	let start: string
	let end: string
	if (day >= second) {
		start = monthDate(year, month, 0, second)
		end = addDays(monthDate(year, month, 1, anchorDay), -1)
	} else if (day >= anchorDay) {
		start = monthDate(year, month, 0, anchorDay)
		end = addDays(monthDate(year, month, 0, second), -1)
	} else {
		start = monthDate(year, month, -1, second)
		end = addDays(monthDate(year, month, 0, anchorDay), -1)
	}
	return { type, start, end, days: lengthDays(start, end) }
}

export function previousPayPeriod(
	period: PayPeriod,
	config: PayPeriodConfig,
): PayPeriod {
	return payPeriodFor(addDays(period.start, -1), config)
}

export function nextPayPeriod(
	period: PayPeriod,
	config: PayPeriodConfig,
): PayPeriod {
	return payPeriodFor(addDays(period.end, 1), config)
}
