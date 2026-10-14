import { describe, expect, it } from 'vitest'
import {
	hhmmFromMinuteOfDay,
	localDateOf,
	localMinuteOfDay,
	MAX_SHIFT_MINUTES,
	minuteOfDayFromHhmm,
	placeWallClock,
	resolveShiftWindow,
	segmentByLocalDay,
	startOfLocalDay,
	wallClockOf,
	weekRangeMs,
} from './schedule-time.ts'
import { zonedLocalToUtc } from './tz.ts'

const CHI = 'America/Chicago'
const RIYADH = 'Asia/Riyadh'
const TORONTO = 'America/Toronto'

function at(date: string, hhmm: string, tz = CHI) {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	const [h, min] = hhmm.split(':').map(Number) as [number, number]
	return zonedLocalToUtc(y, m, d, h, min, tz)
}

function shift(
	date: string,
	start: string,
	end: string,
	tz = CHI,
): { startsAt: number; endsAt: number; minutes: number } {
	const result = resolveShiftWindow({
		date,
		startMinute: minuteOfDayFromHhmm(start),
		endMinute: minuteOfDayFromHhmm(end),
		timeZone: tz,
	})
	if (!result.ok) throw new Error(`unexpected ${result.reason}`)
	return {
		startsAt: result.window.startsAt,
		endsAt: result.window.endsAt,
		minutes: result.window.durationMinutes,
	}
}

describe('hh:mm helpers', () => {
	it('converts both ways and clamps what cannot be shown', () => {
		expect(minuteOfDayFromHhmm('09:30')).toBe(570)
		expect(minuteOfDayFromHhmm('00:00')).toBe(0)
		expect(minuteOfDayFromHhmm('23:59')).toBe(1439)
		expect(hhmmFromMinuteOfDay(570)).toBe('09:30')
		expect(hhmmFromMinuteOfDay(1440)).toBe('23:59')
		expect(hhmmFromMinuteOfDay(-5)).toBe('00:00')
	})
})

describe('resolveShiftWindow', () => {
	it('resolves a plain day shift in the scope zone', () => {
		const s = shift('2026-03-02', '09:00', '17:00')
		expect(s.startsAt).toBe(at('2026-03-02', '09:00'))
		expect(s.endsAt).toBe(at('2026-03-02', '17:00'))
		expect(s.minutes).toBe(480)
	})

	it('reads an end at or before the start as the next day', () => {
		const night = shift('2026-03-02', '22:00', '02:00')
		expect(night.minutes).toBe(240)
		expect(night.endsAt).toBe(at('2026-03-03', '02:00'))
		// Ending at midnight is the next day's midnight, not zero length.
		expect(shift('2026-03-02', '18:00', '00:00').minutes).toBe(360)
		// A shift that ends one minute before it starts is almost a full day.
		expect(shift('2026-03-02', '09:00', '08:59').minutes).toBe(23 * 60 + 59)
	})

	it('refuses a zero-length shift instead of reading it as 24 hours', () => {
		expect(
			resolveShiftWindow({
				date: '2026-03-02',
				startMinute: 540,
				endMinute: 540,
				timeZone: CHI,
			}),
		).toEqual({ ok: false, reason: 'zero_length' })
	})

	it('measures a shift across spring-forward by real time', () => {
		// 2026-03-08 02:00 to 03:00 does not exist in Chicago.
		expect(shift('2026-03-08', '01:00', '04:00').minutes).toBe(120)
		// An overnight shift over the change is an hour shorter than it reads.
		expect(shift('2026-03-07', '22:00', '06:00').minutes).toBe(7 * 60)
	})

	it('measures a shift across fall-back by real time', () => {
		// 2026-11-01 01:00 to 02:00 happens twice; the first one is used.
		expect(shift('2026-11-01', '01:00', '04:00').minutes).toBe(240)
		expect(shift('2026-10-31', '22:00', '06:00').minutes).toBe(9 * 60)
	})

	it('has no clock changes in Riyadh', () => {
		expect(shift('2026-03-07', '22:00', '06:00', RIYADH).minutes).toBe(480)
		expect(shift('2026-11-01', '01:00', '04:00', RIYADH).minutes).toBe(180)
		expect(shift('2026-03-02', '09:00', '17:00', RIYADH).startsAt).toBe(
			Date.UTC(2026, 2, 2, 6, 0, 0),
		)
	})

	it('follows Toronto, which changes clocks on the same Sundays as Chicago', () => {
		expect(shift('2026-03-07', '22:00', '06:00', TORONTO).minutes).toBe(7 * 60)
	})
})

describe('wall clock round trip', () => {
	it('keeps 9:00 at 9:00 when a shift is moved across a clock change', () => {
		const before = shift('2026-03-06', '09:00', '17:00') // Friday, CST
		const wall = wallClockOf(before.startsAt, before.endsAt, CHI)
		expect(wall).toMatchObject({
			date: '2026-03-06',
			startMinute: 540,
			endDayOffset: 0,
			endMinute: 1020,
		})
		const after = placeWallClock({
			date: '2026-03-13', // Friday, CDT
			wallClock: wall,
			timeZone: CHI,
			fallbackDurationMinutes: 480,
		})
		expect(after).toMatchObject({ ok: true })
		if (!after.ok) return
		expect(after.window.startsAt).toBe(at('2026-03-13', '09:00'))
		expect(after.window.endsAt).toBe(at('2026-03-13', '17:00'))
		// The UTC instants moved by a week less an hour.
		expect(after.window.startsAt - before.startsAt).toBe(
			7 * 86_400_000 - 3_600_000,
		)
	})

	it('records an overnight shift as an end on the next day', () => {
		const night = shift('2026-03-02', '22:00', '02:00')
		expect(wallClockOf(night.startsAt, night.endsAt, CHI)).toMatchObject({
			startMinute: 1320,
			endDayOffset: 1,
			endMinute: 120,
		})
	})

	it('moves an overnight shift onto the clock-change night with its real length', () => {
		const night = shift('2026-02-28', '22:00', '06:00')
		const wall = wallClockOf(night.startsAt, night.endsAt, CHI)
		const moved = placeWallClock({
			date: '2026-03-07',
			wallClock: wall,
			timeZone: CHI,
			fallbackDurationMinutes: 480,
		})
		expect(moved.ok && moved.window.durationMinutes).toBe(7 * 60)
	})

	it('keeps the original length when the end lands inside the spring-forward gap', () => {
		// Starts at 02:30 (in the gap, so 03:30) and "ends" at 03:00 (before it).
		const placed = placeWallClock({
			date: '2026-03-08',
			wallClock: { startMinute: 150, endDayOffset: 0, endMinute: 180 },
			timeZone: CHI,
			fallbackDurationMinutes: 30,
		})
		expect(placed.ok).toBe(true)
		if (!placed.ok) return
		expect(placed.window.endsAt - placed.window.startsAt).toBe(30 * 60_000)
		expect(placed.window.durationMinutes).toBe(30)
	})

	it('refuses a shift longer than a day and an hour', () => {
		expect(MAX_SHIFT_MINUTES).toBe(1500)
		const placed = placeWallClock({
			date: '2026-03-02',
			wallClock: { startMinute: 540, endDayOffset: 2, endMinute: 540 },
			timeZone: CHI,
			fallbackDurationMinutes: 60,
		})
		expect(placed).toEqual({ ok: false, reason: 'too_long' })
	})
})

describe('local dates and week ranges', () => {
	it('reads the local date and minute of an instant', () => {
		const ms = Date.UTC(2026, 2, 2, 3, 30, 0) // 21:30 on Mar 1 in Chicago
		expect(localDateOf(ms, CHI)).toBe('2026-03-01')
		expect(localMinuteOfDay(ms, CHI)).toBe(21 * 60 + 30)
		expect(localDateOf(ms, RIYADH)).toBe('2026-03-02')
		expect(localMinuteOfDay(ms, RIYADH)).toBe(6 * 60 + 30)
	})

	it('spans 167 hours for the week that loses an hour and 169 for the one that gains it', () => {
		const normal = weekRangeMs('2026-03-09', CHI)
		expect(normal.startMs).toBe(startOfLocalDay('2026-03-09', CHI))
		expect((normal.endMs - normal.startMs) / 3_600_000).toBe(168)
		// A Monday week and a Sunday week both contain Sunday 2026-03-08.
		const monday = weekRangeMs('2026-03-02', CHI)
		expect((monday.endMs - monday.startMs) / 3_600_000).toBe(167)
		const dst = weekRangeMs('2026-03-08', CHI)
		expect((dst.endMs - dst.startMs) / 3_600_000).toBe(167)
		const fall = weekRangeMs('2026-11-01', CHI)
		expect((fall.endMs - fall.startMs) / 3_600_000).toBe(169)
		const fallMonday = weekRangeMs('2026-10-26', CHI)
		expect((fallMonday.endMs - fallMonday.startMs) / 3_600_000).toBe(169)
		const riyadh = weekRangeMs('2026-03-08', RIYADH)
		expect((riyadh.endMs - riyadh.startMs) / 3_600_000).toBe(168)
	})
})

describe('segmentByLocalDay', () => {
	it('keeps a same-day shift in one piece', () => {
		const s = shift('2026-03-02', '09:00', '17:00')
		expect(segmentByLocalDay(s.startsAt, s.endsAt, CHI)).toEqual([
			{ date: '2026-03-02', startMinute: 540, endMinute: 1020 },
		])
	})

	it('splits an overnight shift at midnight', () => {
		const s = shift('2026-03-02', '22:00', '02:00')
		expect(segmentByLocalDay(s.startsAt, s.endsAt, CHI)).toEqual([
			{ date: '2026-03-02', startMinute: 1320, endMinute: 1440 },
			{ date: '2026-03-03', startMinute: 0, endMinute: 120 },
		])
	})

	it('ends a piece at 1440 when the shift stops at midnight', () => {
		const s = shift('2026-03-02', '18:00', '00:00')
		expect(segmentByLocalDay(s.startsAt, s.endsAt, CHI)).toEqual([
			{ date: '2026-03-02', startMinute: 1080, endMinute: 1440 },
		])
	})

	it('splits correctly on the spring-forward night', () => {
		const s = shift('2026-03-07', '22:00', '06:00')
		expect(segmentByLocalDay(s.startsAt, s.endsAt, CHI)).toEqual([
			{ date: '2026-03-07', startMinute: 1320, endMinute: 1440 },
			{ date: '2026-03-08', startMinute: 0, endMinute: 360 },
		])
	})

	it('returns nothing for an empty or backwards interval', () => {
		expect(segmentByLocalDay(10, 10, CHI)).toEqual([])
		expect(segmentByLocalDay(20, 10, CHI)).toEqual([])
	})
})
