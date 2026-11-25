import {
	buildOnlineLocationHours,
	locationOpenIntervals,
	type OnlineAvailabilityInput,
} from '@repo/opening-hours'
import {
	addDays,
	formatDate,
	isValidTimeZone,
	localParts,
} from '@repo/zoned-time'
import {
	intersectWindows,
	subtractWindows,
	type TimeWindow,
} from './ordering-windows.ts'

/**
 * Scheduled online open hours as windows (#176, #405), from the same hours the
 * guest sees (`@repo/opening-hours`: weekly pattern, online override, special
 * days). Pure.
 */

/**
 * The scheduled online hours inside `range`, or `null` when no hours are
 * configured (the location is open whenever it is asked: callers treat that as
 * open all the time). An inactive location has none.
 */
export function onlineOpenWindows(
	raw: OnlineAvailabilityInput,
	range: TimeWindow,
): TimeWindow[] | null {
	const zone = isValidTimeZone(raw.timeZone) ? raw.timeZone : 'UTC'
	const first = localParts(range.from, zone)
	const last = localParts(range.to, zone)
	// A day either side catches an overnight stretch that crosses the range.
	const fromDate = addDays(formatDate(first.year, first.month, first.day), -1)
	const toDate = addDays(formatDate(last.year, last.month, last.day), 1)
	const intervals = locationOpenIntervals(
		buildOnlineLocationHours({ ...raw, timeZone: zone }),
		fromDate,
		toDate,
		'online',
	)
	if (intervals === null) return null
	return intersectWindows(
		intervals.map((interval) => ({
			from: interval.startMs,
			to: interval.endMs,
		})),
		[range],
	)
}

/** How far ahead an hours edit counts as taking scheduled time away at short notice. */
export const CLOSURE_HORIZON_MS = 36 * 3_600_000

/**
 * The scheduled online hours an edit took away at short notice: what the old
 * hours had open between `now` and the next 36 hours that the new hours do not.
 * These are written as `closure` rows (closed unexpectedly): scheduled time
 * that was lost, so a location that cuts tonight's hours at 5 pm shows it
 * instead of looking like it was never meant to be open.
 */
export function planHoursClosures(input: {
	before: OnlineAvailabilityInput
	after: OnlineAvailabilityInput
	now: number
	horizonMs?: number
}): TimeWindow[] {
	const range = { from: input.now, to: input.now + (input.horizonMs ?? CLOSURE_HORIZON_MS) }
	const before = onlineOpenWindows(input.before, range)
	// Open all the time before, or no hours at all, then nothing was scheduled to lose.
	if (before === null || before.length === 0) return []
	const after = onlineOpenWindows(input.after, range)
	if (after === null) return []
	return subtractWindows(before, after).filter(
		// A sliver under a minute is rounding, not a closure.
		(window) => window.to - window.from >= 60_000,
	)
}
