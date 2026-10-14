import { z } from 'zod'
import {
	addDays,
	formatDate,
	localParts,
	parseDate,
	zonedLocalToUtc,
} from './tz.ts'

/**
 * Wall-clock math for shifts. A shift is entered, copied and templated as local
 * wall-clock times in the scope's time zone ("9:00 to 17:00 on Friday"), and
 * stored as UTC instants. Converting each time through the zone keeps a copied
 * shift at 9:00 across a daylight saving change, and a shift's real length is
 * measured from the instants, so a night shift over a clock change is one hour
 * shorter or longer than its wall-clock span.
 *
 * DST rules (shared with the rest of staffing, see `tz.ts`): a wall-clock time
 * that does not exist resolves to the instant after the gap; one that happens
 * twice resolves to the first.
 */

const MS_PER_MINUTE = 60_000

export const MINUTES_PER_DAY = 1440

/** Longest shift. A day plus an hour, so a fall-back day never trips it. */
export const MAX_SHIFT_MINUTES = 25 * 60
export const MIN_SHIFT_MINUTES = 1

export const hhmmSchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the format HH:MM (24 hour)')

export function minuteOfDayFromHhmm(value: string): number {
	const [h, m] = value.split(':').map(Number) as [number, number]
	return h * 60 + m
}

export function hhmmFromMinuteOfDay(minute: number): string {
	const clamped = Math.min(Math.max(Math.trunc(minute), 0), MINUTES_PER_DAY - 1)
	return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

/** Wall-clock minutes after local midnight at an instant. */
export function localMinuteOfDay(ms: number, timeZone: string): number {
	const p = localParts(ms, timeZone)
	return p.hour * 60 + p.minute
}

/** The local calendar date (`YYYY-MM-DD`) of an instant. */
export function localDateOf(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone)
	return formatDate(p.year, p.month, p.day)
}

/** The instant a local calendar date begins. */
export function startOfLocalDay(date: string, timeZone: string): number {
	const { year, month, day } = parseDate(date)
	return zonedLocalToUtc(year, month, day, 0, 0, timeZone)
}

/** The instants a seven-day week beginning on `weekStart` spans: `[start, end)`. */
export function weekRangeMs(
	weekStart: string,
	timeZone: string,
): { startMs: number; endMs: number } {
	return {
		startMs: startOfLocalDay(weekStart, timeZone),
		endMs: startOfLocalDay(addDays(weekStart, 7), timeZone),
	}
}

export type ResolvedShiftWindow = {
	startsAt: number
	endsAt: number
	/** Local date of the start. */
	localDate: string
	/** Real length in minutes (after any clock change). */
	durationMinutes: number
}

export type ResolvedShiftWindowFailure = 'zero_length' | 'too_long'

/**
 * Resolve "date, start, end" to instants. An end at or before the start is the
 * next day (an overnight shift), so 22:00 to 02:00 runs four hours and 22:00
 * to 22:00 is refused rather than read as a 24 hour shift.
 */
export function resolveShiftWindow(input: {
	date: string
	startMinute: number
	endMinute: number
	timeZone: string
}):
	| { ok: true; window: ResolvedShiftWindow }
	| { ok: false; reason: ResolvedShiftWindowFailure } {
	const { date, startMinute, endMinute, timeZone } = input
	if (startMinute === endMinute) return { ok: false, reason: 'zero_length' }
	const start = parseDate(date)
	const startsAt = zonedLocalToUtc(
		start.year,
		start.month,
		start.day,
		Math.floor(startMinute / 60),
		startMinute % 60,
		timeZone,
	)
	const endDate = endMinute > startMinute ? date : addDays(date, 1)
	const end = parseDate(endDate)
	const endsAt = zonedLocalToUtc(
		end.year,
		end.month,
		end.day,
		Math.floor(endMinute / 60),
		endMinute % 60,
		timeZone,
	)
	return finishWindow(date, startsAt, endsAt)
}

function finishWindow(
	date: string,
	startsAt: number,
	endsAt: number,
):
	| { ok: true; window: ResolvedShiftWindow }
	| { ok: false; reason: ResolvedShiftWindowFailure } {
	const durationMinutes = Math.round((endsAt - startsAt) / MS_PER_MINUTE)
	if (durationMinutes < MIN_SHIFT_MINUTES) {
		return { ok: false, reason: 'zero_length' }
	}
	if (durationMinutes > MAX_SHIFT_MINUTES) {
		return { ok: false, reason: 'too_long' }
	}
	return {
		ok: true,
		window: { startsAt, endsAt, localDate: date, durationMinutes },
	}
}

/** A shift's start and end as wall-clock values, independent of any one date. */
export type WallClock = {
	startMinute: number
	/** Whole calendar days after the start day that the shift ends on. */
	endDayOffset: number
	endMinute: number
}

export function wallClockOf(
	startsAt: number,
	endsAt: number,
	timeZone: string,
): WallClock & { date: string } {
	const date = localDateOf(startsAt, timeZone)
	const endDate = localDateOf(endsAt, timeZone)
	const a = parseDate(date)
	const b = parseDate(endDate)
	const endDayOffset = Math.round(
		(Date.UTC(b.year, b.month - 1, b.day) -
			Date.UTC(a.year, a.month - 1, a.day)) /
			86_400_000,
	)
	return {
		date,
		startMinute: localMinuteOfDay(startsAt, timeZone),
		endDayOffset,
		endMinute: localMinuteOfDay(endsAt, timeZone),
	}
}

/**
 * Place a wall-clock shift on a date. If a clock change makes the end land at or
 * before the start (a shift ending inside a spring-forward gap), the shift keeps
 * `fallbackDurationMinutes` instead of collapsing.
 */
export function placeWallClock(input: {
	date: string
	wallClock: WallClock
	timeZone: string
	fallbackDurationMinutes: number
}):
	| { ok: true; window: ResolvedShiftWindow }
	| { ok: false; reason: ResolvedShiftWindowFailure } {
	const { date, wallClock, timeZone } = input
	const start = parseDate(date)
	const startsAt = zonedLocalToUtc(
		start.year,
		start.month,
		start.day,
		Math.floor(wallClock.startMinute / 60),
		wallClock.startMinute % 60,
		timeZone,
	)
	const end = parseDate(addDays(date, wallClock.endDayOffset))
	let endsAt = zonedLocalToUtc(
		end.year,
		end.month,
		end.day,
		Math.floor(wallClock.endMinute / 60),
		wallClock.endMinute % 60,
		timeZone,
	)
	if (endsAt <= startsAt) {
		endsAt =
			startsAt + Math.max(1, input.fallbackDurationMinutes) * MS_PER_MINUTE
	}
	return finishWindow(date, startsAt, endsAt)
}

export type DaySegment = {
	/** Local date this piece of the shift falls on. */
	date: string
	/** Wall-clock minutes after local midnight. */
	startMinute: number
	/** Exclusive; 1440 when the piece runs to the end of the day. */
	endMinute: number
}

/**
 * Split an interval at local midnights. A shift from 22:00 to 02:00 is two
 * segments: 22:00 to 24:00 on the first date and 00:00 to 02:00 on the next.
 */
export function segmentByLocalDay(
	startsAt: number,
	endsAt: number,
	timeZone: string,
): DaySegment[] {
	const segments: DaySegment[] = []
	if (endsAt <= startsAt) return segments
	let date = localDateOf(startsAt, timeZone)
	let cursor = startsAt
	// A shift is at most 25 hours, so three days is a safe bound.
	for (let guard = 0; cursor < endsAt && guard < 4; guard++) {
		const nextStart = startOfLocalDay(addDays(date, 1), timeZone)
		const pieceEnd = Math.min(endsAt, nextStart)
		segments.push({
			date,
			startMinute: localMinuteOfDay(cursor, timeZone),
			endMinute:
				pieceEnd >= nextStart
					? MINUTES_PER_DAY
					: localMinuteOfDay(pieceEnd, timeZone),
		})
		cursor = pieceEnd
		date = addDays(date, 1)
	}
	return segments
}
