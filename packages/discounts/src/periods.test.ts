import { describe, expect, it } from 'vitest'
import { discountPeriodKeys, isoWeekKey, localNowString } from './periods.ts'

describe('discount period keys', () => {
	it('starts weeks on Monday', () => {
		// 2026-10-26 is a Monday, 2026-11-01 a Sunday.
		expect(isoWeekKey('2026-10-26')).toBe('2026-W44')
		expect(isoWeekKey('2026-10-30')).toBe('2026-W44')
		expect(isoWeekKey('2026-11-01')).toBe('2026-W44')
		expect(isoWeekKey('2026-11-02')).toBe('2026-W45')
	})

	it('puts the year boundary in the ISO year of its Thursday', () => {
		expect(isoWeekKey('2026-12-31')).toBe('2026-W53')
		expect(isoWeekKey('2027-01-03')).toBe('2026-W53')
		expect(isoWeekKey('2027-01-04')).toBe('2027-W01')
		expect(isoWeekKey('2024-12-30')).toBe('2025-W01')
	})

	it('reads the day and week from the local wall clock', () => {
		expect(discountPeriodKeys('2026-10-30T23:59')).toEqual({
			day: '2026-10-30',
			week: '2026-W44',
		})
	})

	it('computes the wall clock in the location zone, not UTC', () => {
		// 2026-10-30 02:30 UTC is still the 29th evening in New York (UTC-4).
		const ms = Date.UTC(2026, 9, 30, 2, 30)
		expect(localNowString(ms, 'America/New_York')).toBe('2026-10-29T22:30')
		expect(localNowString(ms, 'Asia/Riyadh')).toBe('2026-10-30T05:30')
		// A Sunday night in New York is the next Monday in UTC: the week differs.
		const sunday = Date.UTC(2026, 10, 2, 1, 0)
		expect(
			discountPeriodKeys(localNowString(sunday, 'America/New_York')).week,
		).toBe('2026-W44')
		expect(discountPeriodKeys(localNowString(sunday, 'UTC')).week).toBe(
			'2026-W45',
		)
	})
})
