import { describe, expect, it } from 'vitest'
import { type MyShift } from './my-schedule-api.ts'
import {
	formatDay,
	formatDelta,
	formatPaid,
	formatRange,
	formatSpan,
	formatStamp,
	formatTime,
	groupByDay,
	intlLocale,
	nextShift,
	todayIn,
	windowFrom,
} from './my-schedule-format.ts'

const CHI = 'America/Chicago'
// Monday 2026-03-02 09:00 in Chicago (CST).
const NINE = Date.UTC(2026, 2, 2, 15, 0, 0)
const HOUR = 3_600_000

function shift(overrides: Partial<MyShift> = {}): MyShift {
	return {
		id: 's1',
		scopeId: 'loc-1',
		positionName: 'Cook',
		positionNameAr: null,
		startsAt: NINE,
		endsAt: NINE + 8 * HOUR,
		localDate: '2026-03-02',
		timeZone: CHI,
		unpaidBreakMinutes: 0,
		notes: null,
		...overrides,
	}
}

describe('times in the workplace zone', () => {
	it('shows a shift where the workplace keeps it, not where the phone is', () => {
		expect(formatRange(NINE, NINE + 8 * HOUR, CHI, 'en')).toMatch(
			/^9:00\sAM\s–\s5:00\sPM$/,
		)
		expect(formatTime(NINE, 'Asia/Riyadh', 'en')).toMatch(/^6:00\sPM$/)
	})

	it('falls back to UTC for a zone it does not know instead of throwing', () => {
		expect(formatTime(NINE, 'Mars/Olympus', 'en')).toMatch(/^3:00\sPM$/)
		expect(todayIn(NINE, 'Mars/Olympus')).toBe('2026-03-02')
	})

	it('uses Western digits in Arabic, like the emails and the time clock', () => {
		expect(intlLocale('ar')).toBe('ar-u-nu-latn')
		expect(intlLocale('en')).toBe('en')
		expect(formatTime(NINE, CHI, 'ar')).toMatch(/9:00/)
		expect(formatTime(NINE, CHI, 'ar')).not.toMatch(/[٠-٩]/)
		expect(formatDay('2026-03-02', 'ar')).not.toMatch(/[٠-٩]/)
	})

	it('says what day it is where the workplace is', () => {
		// 2026-03-03 03:00 UTC is still Monday evening in Chicago.
		expect(todayIn(Date.UTC(2026, 2, 3, 3, 0, 0), CHI)).toBe('2026-03-02')
		expect(todayIn(Date.UTC(2026, 2, 3, 3, 0, 0), 'Asia/Riyadh')).toBe(
			'2026-03-03',
		)
	})
})

describe('dates', () => {
	it('formats a calendar date without shifting it by the zone', () => {
		expect(formatDay('2026-03-02', 'en')).toBe('Mon, Mar 2')
		expect(formatDay('2026-03-02', 'en', { weekday: 'long' })).toBe('Monday')
		expect(formatSpan('2026-03-02', '2026-03-08', 'en')).toMatch(
			/^Mar 2\s*–\s*8$/,
		)
		expect(formatDay('garbage', 'en')).not.toBe('')
	})

	it('stamps an instant in the workplace zone', () => {
		expect(formatStamp(NINE, CHI, 'en')).toMatch(/^Mar 2, 9:00\sAM$/)
	})

	it('moves a window by whole days', () => {
		expect(windowFrom('2026-03-02', 28, 35)).toEqual({
			from: '2026-03-30',
			to: '2026-05-03',
		})
		expect(windowFrom('2026-03-02', -28, 35)).toEqual({
			from: '2026-02-02',
			to: '2026-03-08',
		})
	})
})

describe('hours', () => {
	it('words paid time in both languages', () => {
		expect(formatPaid(450, 'en')).toBe('7 h 30 min')
		expect(formatPaid(480, 'en')).toBe('8 h')
		expect(formatPaid(45, 'en')).toBe('45 min')
		expect(formatPaid(0, 'en')).toBe('0 min')
		expect(formatPaid(-5, 'en')).toBe('0 min')
		expect(formatPaid(450, 'ar')).toBe('7 س 30 د')
	})

	it('shows a change in hours with its sign', () => {
		expect(formatDelta(-30)).toBe('-0:30')
		expect(formatDelta(75)).toBe('+1:15')
		expect(formatDelta(0)).toBe('+0:00')
	})
})

describe('the list', () => {
	it('groups shifts by business date in time order, several to a day', () => {
		const groups = groupByDay([
			shift({ id: 'c', localDate: '2026-03-03', startsAt: NINE + 24 * HOUR }),
			shift({ id: 'b', startsAt: NINE + 9 * HOUR, endsAt: NINE + 13 * HOUR }),
			shift({ id: 'a' }),
		])
		expect(groups.map((g) => [g.date, g.shifts.map((s) => s.id)])).toEqual([
			['2026-03-02', ['a', 'b']],
			['2026-03-03', ['c']],
		])
		expect(groupByDay([])).toEqual([])
	})

	it('finds the next shift that has not ended', () => {
		const shifts = [
			shift({
				id: 'past',
				startsAt: NINE - 48 * HOUR,
				endsAt: NINE - 40 * HOUR,
			}),
			shift({ id: 'now' }),
			shift({
				id: 'later',
				startsAt: NINE + 30 * HOUR,
				endsAt: NINE + 38 * HOUR,
			}),
		]
		expect(nextShift(shifts, NINE + HOUR)?.id).toBe('now')
		expect(nextShift(shifts, NINE + 9 * HOUR)?.id).toBe('later')
		expect(nextShift(shifts, NINE + 100 * HOUR)).toBeNull()
		expect(nextShift([], NINE)).toBeNull()
	})
})
