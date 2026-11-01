import { addDays, daysBetween, dayOfWeek, localParts } from '@repo/zoned-time'

/**
 * Calendar keys for per-customer limits. They are computed in the location's
 * time zone (never UTC), so "once a day" and "once a week" follow the
 * restaurant's own calendar. Weeks start on Monday (ISO 8601).
 */

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/**
 * Wall clock in `timeZone` as `YYYY-MM-DDTHH:MM`, the engine's `localNow`. An
 * empty or unknown time zone (a location saved without one) reads as UTC
 * instead of throwing, so a checkout never fails on it.
 */
export function localNowString(ms: number, timeZone: string): string {
	let parts
	try {
		parts = localParts(ms, timeZone || 'UTC')
	} catch (error) {
		if (!(error instanceof RangeError) || !Number.isFinite(ms)) throw error
		parts = localParts(ms, 'UTC')
	}
	return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

/** ISO week of a `YYYY-MM-DD` date as `YYYY-Www` (Monday start). */
export function isoWeekKey(date: string): string {
	const sinceMonday = (dayOfWeek(date) + 6) % 7
	const monday = addDays(date, -sinceMonday)
	// The ISO year is the one that holds the week's Thursday.
	const thursday = addDays(monday, 3)
	const year = thursday.slice(0, 4)
	const jan4 = `${year}-01-04`
	const firstMonday = addDays(jan4, -((dayOfWeek(jan4) + 6) % 7))
	const week = 1 + Math.floor(daysBetween(firstMonday, monday) / 7)
	return `${year}-W${pad(week)}`
}

export type DiscountPeriodKeys = { day: string; week: string }

/** `local_day` and `local_week` of a `YYYY-MM-DDTHH:MM` local time. */
export function discountPeriodKeys(localNow: string): DiscountPeriodKeys {
	const day = localNow.slice(0, 10)
	return { day, week: isoWeekKey(day) }
}
