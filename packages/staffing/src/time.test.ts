import { describe, expect, it } from 'vitest'
import {
	addDays,
	daysBetween,
	isLocalDate,
	isValidTimeZone,
	localDateOf,
	localTimeOf,
	shiftInstants,
	startOfWeek,
	timeZoneOffsetMinutes,
	weekDates,
	zonedWallTimeToUtc,
} from './time.ts'

const NY = 'America/New_York'
const RIYADH = 'Asia/Riyadh'

describe('local dates', () => {
	it('validates real calendar dates only', () => {
		expect(isLocalDate('2026-02-28')).toBe(true)
		expect(isLocalDate('2026-02-29')).toBe(false)
		expect(isLocalDate('2028-02-29')).toBe(true)
		expect(isLocalDate('2026-13-01')).toBe(false)
		expect(isLocalDate('26-01-01')).toBe(false)
	})

	it('adds days across month and year ends', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
		expect(daysBetween('2026-10-05', '2026-10-12')).toBe(7)
	})

	it('starts weeks on Monday or Sunday', () => {
		// 2026-10-14 is a Wednesday.
		expect(startOfWeek('2026-10-14', 'monday')).toBe('2026-10-12')
		expect(startOfWeek('2026-10-14', 'sunday')).toBe('2026-10-11')
		expect(startOfWeek('2026-10-11', 'monday')).toBe('2026-10-05')
		expect(startOfWeek('2026-10-11', 'sunday')).toBe('2026-10-11')
		expect(weekDates('2026-10-11')).toHaveLength(7)
		expect(weekDates('2026-10-11').at(-1)).toBe('2026-10-17')
	})

	it('rejects unknown time zones', () => {
		expect(isValidTimeZone(NY)).toBe(true)
		expect(isValidTimeZone('Mars/Olympus')).toBe(false)
		expect(isValidTimeZone('')).toBe(false)
	})
})

describe('wall-clock conversion', () => {
	it('uses the standard and daylight offsets', () => {
		expect(zonedWallTimeToUtc('2026-01-15', '09:00', NY).toISOString()).toBe(
			'2026-01-15T14:00:00.000Z',
		)
		expect(zonedWallTimeToUtc('2026-07-15', '09:00', NY).toISOString()).toBe(
			'2026-07-15T13:00:00.000Z',
		)
	})

	it('has no DST in Riyadh', () => {
		expect(
			timeZoneOffsetMinutes(new Date('2026-01-01T00:00:00Z'), RIYADH),
		).toBe(180)
		expect(
			zonedWallTimeToUtc('2026-07-01', '22:00', RIYADH).toISOString(),
		).toBe('2026-07-01T19:00:00.000Z')
	})

	it('moves a nonexistent spring-forward time forward', () => {
		// 2026-03-08 02:30 does not exist in New York.
		const instant = zonedWallTimeToUtc('2026-03-08', '02:30', NY)
		expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
		expect(localTimeOf(instant, NY)).toBe('03:30')
	})

	it('picks the earlier instant in a fall-back fold', () => {
		// 2026-11-01 01:30 happens twice in New York.
		const instant = zonedWallTimeToUtc('2026-11-01', '01:30', NY)
		expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z')
	})

	it('round-trips local dates near midnight', () => {
		const instant = new Date('2026-10-12T03:30:00Z')
		expect(localDateOf(instant, NY)).toBe('2026-10-11')
		expect(localDateOf(instant, RIYADH)).toBe('2026-10-12')
	})
})

describe('shift instants', () => {
	it('treats an earlier end as overnight', () => {
		const shift = shiftInstants({
			localDate: '2026-10-10',
			startTime: '22:00',
			endTime: '02:00',
			timeZone: NY,
		})
		expect(shift.overnight).toBe(true)
		expect(shift.startAt.toISOString()).toBe('2026-10-11T02:00:00.000Z')
		expect(shift.endAt.toISOString()).toBe('2026-10-11T06:00:00.000Z')
	})

	it('measures real elapsed time across DST changes', () => {
		const spring = shiftInstants({
			localDate: '2026-03-07',
			startTime: '22:00',
			endTime: '06:00',
			timeZone: NY,
		})
		expect((spring.endAt.getTime() - spring.startAt.getTime()) / 3600000).toBe(
			7,
		)
		const fall = shiftInstants({
			localDate: '2026-10-31',
			startTime: '22:00',
			endTime: '06:00',
			timeZone: NY,
		})
		expect((fall.endAt.getTime() - fall.startAt.getTime()) / 3600000).toBe(9)
	})
})
