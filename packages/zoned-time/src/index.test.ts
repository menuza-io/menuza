import { describe, expect, it } from 'vitest'
import {
	addDays,
	addLocalDays,
	businessDateOf,
	businessDayStartMs,
	dayOfWeek,
	isValidTimeZone,
	localMinutesSinceMidnight,
	localParts,
	minutesBetween,
	parseLocalTimestamp,
	startOfLocalDay,
	weekStartFor,
	zonedLocalToUtc,
} from './index.ts'

const iso = (ms: number) => new Date(ms).toISOString()

describe('zonedLocalToUtc', () => {
	it('converts a plain wall-clock time', () => {
		expect(iso(zonedLocalToUtc(2026, 6, 1, 12, 0, 'Asia/Riyadh'))).toBe(
			'2026-06-01T09:00:00.000Z',
		)
		expect(iso(zonedLocalToUtc(2026, 1, 15, 9, 30, 'America/Toronto'))).toBe(
			'2026-01-15T14:30:00.000Z',
		)
	})

	it('resolves a spring-forward gap to the instant after the gap', () => {
		// 02:30 does not exist in Chicago on 2026-03-08; clocks jump 02:00 -> 03:00.
		const ms = zonedLocalToUtc(2026, 3, 8, 2, 30, 'America/Chicago')
		expect(iso(ms)).toBe('2026-03-08T08:30:00.000Z')
		expect(localParts(ms, 'America/Chicago').hour).toBe(3)
	})

	it('resolves a fall-back ambiguity to the first occurrence', () => {
		// 01:30 happens twice in Chicago on 2026-11-01; the first is CDT (UTC-5).
		expect(iso(zonedLocalToUtc(2026, 11, 1, 1, 30, 'America/Chicago'))).toBe(
			'2026-11-01T06:30:00.000Z',
		)
	})

	it('normalizes 24:00 to midnight of the next day', () => {
		expect(zonedLocalToUtc(2026, 6, 1, 24, 0, 'Asia/Riyadh')).toBe(
			zonedLocalToUtc(2026, 6, 2, 0, 0, 'Asia/Riyadh'),
		)
	})
})

describe('calendar helpers', () => {
	it('adds days across month and year ends', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
		expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28')
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
	})

	it('finds the week start for Sunday and Monday weeks', () => {
		expect(dayOfWeek('2026-03-08')).toBe(0)
		expect(weekStartFor('2026-03-08', 0)).toBe('2026-03-08')
		expect(weekStartFor('2026-03-08', 1)).toBe('2026-03-02')
		expect(weekStartFor('2026-03-14', 0)).toBe('2026-03-08')
		expect(weekStartFor('2026-03-14', 1)).toBe('2026-03-09')
		expect(weekStartFor('2026-03-12', 6)).toBe('2026-03-07')
	})

	it('validates IANA timezones and convenience helpers', () => {
		expect(isValidTimeZone('America/New_York')).toBe(true)
		expect(isValidTimeZone('Asia/Riyadh')).toBe(true)
		expect(isValidTimeZone('Not/A_Zone')).toBe(false)
		const ms = parseLocalTimestamp('2026-06-01T14:30', 'Asia/Riyadh')
		expect(iso(ms)).toBe('2026-06-01T11:30:00.000Z')
		expect(localMinutesSinceMidnight(ms, 'Asia/Riyadh')).toBe(14 * 60 + 30)
		expect(startOfLocalDay('2026-06-01', 'Asia/Riyadh')).toBe(
			businessDayStartMs('2026-06-01', 'Asia/Riyadh', 0),
		)
	})
})

describe('business dates', () => {
	it('uses the local calendar date when the workday starts at midnight', () => {
		const ms = zonedLocalToUtc(2026, 6, 10, 1, 0, 'America/Chicago')
		expect(businessDateOf(ms, 'America/Chicago', 0)).toBe('2026-06-10')
	})

	it('assigns early-morning time to the previous business date', () => {
		const ms = zonedLocalToUtc(2026, 6, 10, 2, 0, 'America/Chicago')
		expect(businessDateOf(ms, 'America/Chicago', 240)).toBe('2026-06-09')
		const after = zonedLocalToUtc(2026, 6, 10, 4, 0, 'America/Chicago')
		expect(businessDateOf(after, 'America/Chicago', 240)).toBe('2026-06-10')
	})

	it('measures a spring-forward day as 23 hours and a fall-back day as 25', () => {
		const tz = 'America/Chicago'
		const spring =
			businessDayStartMs('2026-03-09', tz, 0) -
			businessDayStartMs('2026-03-08', tz, 0)
		expect(minutesBetween(0, spring)).toBe(23 * 60)
		const fall =
			businessDayStartMs('2026-11-02', tz, 0) -
			businessDayStartMs('2026-11-01', tz, 0)
		expect(minutesBetween(0, fall)).toBe(25 * 60)
	})

	it('has no DST shift in Riyadh', () => {
		const day =
			businessDayStartMs('2026-03-09', 'Asia/Riyadh', 0) -
			businessDayStartMs('2026-03-08', 'Asia/Riyadh', 0)
		expect(minutesBetween(0, day)).toBe(24 * 60)
	})

	it('rejects wall-clock values the calendar would roll over', () => {
		expect(() => parseLocalTimestamp('2026-02-31T10:00', 'UTC')).toThrow()
		expect(() => parseLocalTimestamp('2026-13-01T10:00', 'UTC')).toThrow()
		expect(() => parseLocalTimestamp('2026-06-01T25:99', 'UTC')).toThrow()
		expect(() => parseLocalTimestamp('2026-06-01T23:59', 'UTC')).not.toThrow()
	})
})
