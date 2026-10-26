import { describe, expect, it } from 'vitest'
import {
	addDays,
	clockLabel,
	daysBetween,
	isDateString,
	safeZone,
	serverTime,
	wallMinutesOn,
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

describe('wall-clock minutes on a business date', () => {
	const NY = 'America/New_York'
	it('counts the clock on the wall, not the minutes elapsed', () => {
		// Spring forward, 2026-03-08: 02:00 jumps to 03:00. 9 PM is minute 1260, not 1200.
		const nine = zonedEpoch('2026-03-08', 21 * 60, NY)
		expect(wallMinutesOn(nine, '2026-03-08', NY)).toBe(21 * 60)
		const midnight = zonedEpoch('2026-03-08', 0, NY)
		// Elapsed time since midnight is an hour short of the wall clock after the change.
		expect((nine - midnight) / 60_000).toBe(21 * 60 - 60)
		expect(
			wallMinutesOn(zonedEpoch('2026-03-08', 3 * 60, NY), '2026-03-08', NY),
		).toBe(3 * 60)
	})
	it('counts it the same on the day clocks go back', () => {
		// Fall back, 2026-11-01: 02:00 repeats the hour. 9 PM is minute 1260, not 1320.
		const nine = zonedEpoch('2026-11-01', 21 * 60, NY)
		const midnight = zonedEpoch('2026-11-01', 0, NY)
		expect((nine - midnight) / 60_000).toBe(21 * 60 + 60)
		expect(wallMinutesOn(nine, '2026-11-01', NY)).toBe(21 * 60)
		// 1:30 AM happens twice; both read 90.
		const first = Date.UTC(2026, 10, 1, 5, 30)
		const second = Date.UTC(2026, 10, 1, 6, 30)
		expect(wallMinutesOn(first, '2026-11-01', NY)).toBe(90)
		expect(wallMinutesOn(second, '2026-11-01', NY)).toBe(90)
	})
	it('runs on past midnight, and back before it', () => {
		const late = zonedEpoch('2026-03-09', 30, NY)
		expect(wallMinutesOn(late, '2026-03-08', NY)).toBe(1440 + 30)
		const early = zonedEpoch('2026-03-07', 23 * 60, NY)
		expect(wallMinutesOn(early, '2026-03-08', NY)).toBe(-60)
	})
	it('reads Riyadh, a zone that never changes its clocks', () => {
		const instant = Date.UTC(2026, 2, 2, 22, 30, 30) // 01:30:30 on the 3rd in Riyadh
		expect(wallMinutesOn(instant, '2026-03-02', 'Asia/Riyadh')).toBe(
			1440 + 90.5,
		)
		expect(wallMinutesOn(instant, '2026-03-03', 'Asia/Riyadh')).toBe(90.5)
	})
	it('falls back to UTC for a zone the runtime does not know', () => {
		expect(safeZone('Mars/Olympus')).toBe('UTC')
		expect(safeZone(null)).toBe('UTC')
		expect(safeZone('Asia/Riyadh')).toBe('Asia/Riyadh')
		expect(
			wallMinutesOn(Date.UTC(2026, 2, 2, 8, 0), '2026-03-02', 'Mars/X'),
		).toBe(480)
	})
	it('counts days between calendar dates', () => {
		expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1)
		expect(daysBetween('2026-03-08', '2026-03-08')).toBe(0)
		expect(daysBetween('2026-03-08', '2026-02-28')).toBe(-8)
	})
	it('names a time after midnight without wrapping it', () => {
		expect(serverTime(25 * 60 + 30)).toBe('25:30')
		expect(serverTime(19 * 60)).toBe('19:00')
		expect(clockLabel(25 * 60 + 30)).toBe('01:30')
	})
})
