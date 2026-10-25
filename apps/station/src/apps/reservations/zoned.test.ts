import { describe, expect, it } from 'vitest'
import {
	addDays,
	clockLabel,
	isDateString,
	zonedDate,
	zonedEpoch,
	zonedMinutes,
} from './zoned.ts'

describe('a location’s own clock', () => {
	it('turns a wall-clock time into the instant, in any zone', () => {
		expect(zonedEpoch('2026-03-02', 19 * 60 + 30, 'UTC')).toBe(
			Date.UTC(2026, 2, 2, 19, 30),
		)
		// Riyadh is UTC+3 all year.
		expect(zonedEpoch('2026-03-02', 19 * 60, 'Asia/Riyadh')).toBe(
			Date.UTC(2026, 2, 2, 16, 0),
		)
		// New York in winter is UTC-5, in summer UTC-4.
		expect(zonedEpoch('2026-01-15', 12 * 60, 'America/New_York')).toBe(
			Date.UTC(2026, 0, 15, 17, 0),
		)
		expect(zonedEpoch('2026-07-15', 12 * 60, 'America/New_York')).toBe(
			Date.UTC(2026, 6, 15, 16, 0),
		)
	})
	it('reads the date and minutes back, even where the date differs from UTC’s', () => {
		const instant = Date.UTC(2026, 2, 2, 22, 30)
		expect(zonedDate(instant, 'UTC')).toBe('2026-03-02')
		expect(zonedDate(instant, 'Asia/Riyadh')).toBe('2026-03-03')
		expect(zonedMinutes(instant, 'Asia/Riyadh')).toBe(60 + 30)
		expect(zonedMinutes(instant, 'UTC')).toBe(22 * 60 + 30)
	})
	it('round-trips across a clock change', () => {
		// US clocks go forward on 2026-03-08: 03:30 exists, 02:30 does not.
		const instant = zonedEpoch('2026-03-08', 3 * 60 + 30, 'America/New_York')
		expect(zonedMinutes(instant, 'America/New_York')).toBe(3 * 60 + 30)
		expect(zonedDate(instant, 'America/New_York')).toBe('2026-03-08')
	})
})

describe('calendar dates', () => {
	it('moves by days over month and year ends', () => {
		expect(addDays('2026-03-02', 1)).toBe('2026-03-03')
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
	})
	it('names slots the way the server does', () => {
		expect(clockLabel(7 * 60 + 5)).toBe('07:05')
		expect(clockLabel(25 * 60)).toBe('01:00')
		expect(isDateString('2026-03-02')).toBe(true)
		expect(isDateString('3/2/2026')).toBe(false)
	})
})
