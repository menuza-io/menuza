import { currentBusinessDate, isValidTimeZone } from '@repo/reservations'

/** Matches the tenant-api default for `rsvLocationSettings.dayStartMin`. */
export const DEFAULT_DAY_START_MIN = 240

/**
 * The business date an instant falls on for a location: the calendar date in
 * the location's time zone of (instant - day start). The UTC date is wrong for
 * most of the evening west of UTC and in the early hours of the next day.
 */
export function serviceDayBusinessDate(
	nowMs: number,
	timeZone: string | null | undefined,
	dayStartMin: number | null | undefined = DEFAULT_DAY_START_MIN,
): string {
	const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC'
	const start =
		typeof dayStartMin === 'number' && Number.isFinite(dayStartMin)
			? dayStartMin
			: DEFAULT_DAY_START_MIN
	return currentBusinessDate(nowMs, zone, start)
}
