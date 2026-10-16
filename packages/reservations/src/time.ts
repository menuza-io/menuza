import {
	addDays,
	businessDateOf,
	businessDayStartMs,
	dayOfWeek,
	daysBetween,
	floorToMinute,
	formatDate,
	isValidTimeZone,
	localMinutesSinceMidnight,
	localParts,
	minutesBetween,
	parseDate,
	parseLocalTimestamp,
	startOfLocalDay,
	tzOffsetMs,
	weekStartFor,
	zonedLocalToUtc,
	type LocalParts,
} from '@repo/zoned-time'

export {
	addDays,
	businessDateOf,
	businessDayStartMs,
	dayOfWeek,
	daysBetween,
	floorToMinute,
	formatDate,
	isValidTimeZone,
	localMinutesSinceMidnight,
	localParts,
	minutesBetween,
	parseDate,
	parseLocalTimestamp,
	startOfLocalDay,
	tzOffsetMs,
	weekStartFor,
	zonedLocalToUtc,
	type LocalParts,
}

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000
export const MINUTES_PER_DAY = 1_440
export const MAX_LOCAL_MIN = 2_880

export type LocalToInstantOptions = {
	/**
	 * How to handle nonexistent wall-clock times inside a spring-forward gap:
	 * - `'skip'` returns `null` (used when generating bookable slots).
	 * - `'after'` (default) resolves to the post-transition instant (`naive - beforeOffset`).
	 */
	gap?: 'skip' | 'after'
	/**
	 * How to disambiguate wall-clock times that occur twice during a fall-back fold:
	 * - `'earlier'` (default) picks the first occurrence (before the fallback).
	 * - `'later'` picks the second occurrence (after the fallback, used for service ends).
	 */
	overlap?: 'earlier' | 'later'
}

export type LocalInstantResolution = {
	instantMs: number
	/** True when the requested wall-clock time fell inside a spring-forward gap and was shifted to the post-gap instant. */
	adjustedForGap: boolean
	/** Alias for `adjustedForGap`. */
	inGap: boolean
	/** True when the requested wall-clock time occurred twice (fall-back fold). */
	ambiguousFold: boolean
	/** Alias for `ambiguousFold`. */
	ambiguous: boolean
	/** First (DST / pre-fallback) instant when `ambiguousFold` is true. */
	earlierInstantMs?: number
	/** Second (standard / post-fallback) instant when `ambiguousFold` is true. */
	laterInstantMs?: number
	/** Alias for `laterInstantMs`. */
	secondInstantMs?: number
}

/**
 * Convert `businessDate` (`YYYY-MM-DD`) + `localStartMin` (`0..2880`) in `timeZone`
 * to a UTC epoch millisecond instant, with explicit DST gap/fold metadata.
 *
 * Rules (`architecture.md` §6.1 / `VAL-FND-003`):
 *  - `localStartMin >= 1440` represents a midnight-crossing time on `addDays(businessDate, floor(localStartMin / 1440))`
 *    at `localStartMin % 1440`.
 *  - Spring-forward gap (non-existent wall-clock time): returns `null` when `opts?.gap === 'skip'`,
 *    or resolves to the post-gap instant (`naive - beforeOffset`) with `adjustedForGap: true` when `gap === 'after'` (default).
 *  - Fall-back fold (ambiguous wall-clock time occurring twice): resolves to the first (`overlap: 'earlier'`, default)
 *    or second (`overlap: 'later'`) occurrence and sets `ambiguousFold: true`.
 */
export function localToInstant(
	businessDate: string,
	localStartMin: number,
	timeZone: string,
	opts: { gap: 'skip'; overlap?: 'earlier' | 'later' },
): LocalInstantResolution | null
export function localToInstant(
	businessDate: string,
	localStartMin: number,
	timeZone: string,
	opts?: LocalToInstantOptions,
): LocalInstantResolution
export function localToInstant(
	businessDate: string,
	localStartMin: number,
	timeZone: string,
	opts?: LocalToInstantOptions,
): LocalInstantResolution | null {
	const dayOffset = Math.floor(localStartMin / MINUTES_PER_DAY)
	const minuteOfDay =
		((localStartMin % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
	const calendarDate =
		dayOffset === 0 ? businessDate : addDays(businessDate, dayOffset)
	const { year, month, day } = parseDate(calendarDate)
	const hour = Math.floor(minuteOfDay / 60)
	const minute = minuteOfDay % 60

	const naive = Date.UTC(year, month - 1, day, hour, minute, 0)
	const before = tzOffsetMs(naive - MS_PER_DAY, timeZone)
	const after = tzOffsetMs(naive + MS_PER_DAY, timeZone)
	const offsets = [...new Set([before, after])]
	const candidates = offsets
		.map((offset) => naive - offset)
		.sort((a, b) => a - b)

	const matching = candidates.filter(
		(candidate) => tzOffsetMs(candidate, timeZone) + candidate === naive,
	)

	if (matching.length >= 2) {
		const earlier = matching[0]!
		const later = matching[matching.length - 1]!
		const chosen = opts?.overlap === 'later' ? later : earlier
		return {
			instantMs: chosen,
			adjustedForGap: false,
			inGap: false,
			ambiguousFold: true,
			ambiguous: true,
			earlierInstantMs: earlier,
			laterInstantMs: later,
			secondInstantMs: later,
		}
	}
	if (matching.length === 1) {
		return {
			instantMs: matching[0]!,
			adjustedForGap: false,
			inGap: false,
			ambiguousFold: false,
			ambiguous: false,
		}
	}
	if (opts?.gap === 'skip') {
		return null
	}
	// Non-existent wall-clock time (spring-forward gap): use pre-transition offset
	return {
		instantMs: naive - before,
		adjustedForGap: true,
		inGap: true,
		ambiguousFold: false,
		ambiguous: false,
	}
}

export type LocalBusinessTime = {
	businessDate: string
	/** Minutes from `00:00` of `businessDate`; `>= 1440` when after midnight before `dayStartMin`. */
	localStartMin: number
	/** Actual calendar date `YYYY-MM-DD` in `timeZone`. */
	calendarDate: string
	/** Wall-clock minutes `0..1439` on `calendarDate`. */
	clockMin: number
}

/**
 * Convert an instant (`ms`) in `timeZone` back to `{ businessDate, localStartMin, calendarDate, clockMin }`.
 * When the local wall-clock time is before `dayStartMin` (e.g. `01:30` with `dayStartMin = 240`),
 * the instant belongs to the previous `businessDate` with `localStartMin = clockMin + 1440`.
 */
export function instantToLocal(
	ms: number,
	timeZone: string,
	dayStartMin = 240,
): LocalBusinessTime {
	const parts = localParts(ms, timeZone)
	const calendarDate = formatDate(parts.year, parts.month, parts.day)
	const clockMin = parts.hour * 60 + parts.minute
	const bDate = businessDateOf(ms, timeZone, dayStartMin)
	const dayDiff = daysBetween(bDate, calendarDate)
	return {
		businessDate: bDate,
		localStartMin: clockMin + dayDiff * MINUTES_PER_DAY,
		calendarDate,
		clockMin,
	}
}

/**
 * Determine the location's current `businessDate` (`YYYY-MM-DD`) at `nowMs` given
 * `timeZone` and `dayStartMin` (default `240` = 04:00 local).
 */
export function currentBusinessDate(
	nowMs: number,
	timeZone: string,
	dayStartMin = 240,
): string {
	return businessDateOf(nowMs, timeZone, dayStartMin)
}

export type ServiceWindowInstants = {
	startMs: number
	endMs: number
	durationMin: number
	startAdjustedForGap: boolean
	endAdjustedForGap: boolean
}

/**
 * Resolve `[startMin, endMin)` on `businessDate` in `timeZone` to UTC instants.
 * `endMin` may be `<= 2880` (e.g. `1560` for `02:00` next morning). If `endMin <= startMin`,
 * `endMin` is treated as crossing midnight (`endMin + 1440`).
 */
export function resolveServiceWindow(
	businessDate: string,
	startMin: number,
	endMin: number,
	timeZone: string,
): ServiceWindowInstants {
	const normalizedEndMin =
		endMin <= startMin ? endMin + MINUTES_PER_DAY : endMin
	const start = localToInstant(businessDate, startMin, timeZone, {
		gap: 'after',
		overlap: 'earlier',
	})
	const end = localToInstant(businessDate, normalizedEndMin, timeZone, {
		gap: 'after',
		overlap: 'later',
	})
	return {
		startMs: start.instantMs,
		endMs: end.instantMs,
		durationMin: Math.max(
			0,
			Math.round((end.instantMs - start.instantMs) / MS_PER_MINUTE),
		),
		startAdjustedForGap: start.adjustedForGap,
		endAdjustedForGap: end.adjustedForGap,
	}
}

/** Format a local minute offset (`0..2880`) as `HH:MM` (`00:00..23:59`). */
export function formatHhmm(localMin: number): string {
	const mod =
		((Math.trunc(localMin) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
		MINUTES_PER_DAY
	const h = Math.floor(mod / 60)
	const m = mod % 60
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse a `HH:MM` string into minutes (`0..1439`). */
export function parseHhmm(hhmm: string): number {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
	if (!match) {
		throw new Error(`Invalid HH:MM time string: ${hhmm}`)
	}
	return Number(match[1]) * 60 + Number(match[2])
}
