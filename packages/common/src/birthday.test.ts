import { describe, expect, it } from 'vitest'
import {
	birthdayDue,
	birthdayInYear,
	candidateBirthMonthDays,
	parseBirthMonthDay,
	toBirthMonthDay,
} from './birthday.ts'

describe('birthday', () => {
	it('accepts real month-days only, including 29 February', () => {
		expect(parseBirthMonthDay('02-29')).toBe('02-29')
		expect(parseBirthMonthDay('12-31')).toBe('12-31')
		for (const bad of ['02-30', '13-01', '00-10', '1-1', '2000-01-01', '04-31', '', null, 5]) {
			expect(parseBirthMonthDay(bad)).toBeNull()
		}
		expect(toBirthMonthDay(3, 7)).toBe('03-07')
		expect(toBirthMonthDay(2, 31)).toBeNull()
	})

	it('celebrates 29 February on 28 February in a non-leap year', () => {
		expect(birthdayInYear('02-29', 2027)).toEqual({ month: 2, day: 28 })
		expect(birthdayInYear('02-29', 2028)).toEqual({ month: 2, day: 29 })
	})

	it('is due N days before, from 10:00 local, and catches up the next day', () => {
		const base = { birthMonthDay: '03-10', daysBefore: 7 }
		const day = (month: number, d: number, hour: number) => ({
			...base,
			today: { year: 2027, month, day: d },
			hour,
		})
		expect(birthdayDue(day(3, 3, 9)).due).toBe(false)
		expect(birthdayDue(day(3, 3, 10))).toEqual({ due: true, year: 2027 })
		// The pass was down yesterday: still due today.
		expect(birthdayDue(day(3, 4, 3)).due).toBe(true)
		expect(birthdayDue(day(3, 5, 12)).due).toBe(false)
		expect(birthdayDue(day(3, 2, 12)).due).toBe(false)
	})

	it('a 29 February birthday fires for 28 February in a non-leap year, and across New Year', () => {
		expect(
			birthdayDue({
				birthMonthDay: '02-29',
				daysBefore: 7,
				today: { year: 2027, month: 2, day: 21 },
				hour: 11,
			}),
		).toEqual({ due: true, year: 2027 })
		expect(
			birthdayDue({
				birthMonthDay: '02-29',
				daysBefore: 7,
				today: { year: 2028, month: 2, day: 22 },
				hour: 11,
			}),
		).toEqual({ due: true, year: 2028 })
		expect(
			birthdayDue({
				birthMonthDay: '01-03',
				daysBefore: 7,
				today: { year: 2026, month: 12, day: 27 },
				hour: 10,
			}),
		).toEqual({ due: true, year: 2027 })
	})

	it('lists the month-days to prefilter on, with 02-29 beside 02-28', () => {
		const values = candidateBirthMonthDays({ year: 2027, month: 2, day: 21 }, 7)
		expect(values).toContain('02-28')
		expect(values).toContain('02-29')
		expect(values.length).toBeLessThanOrEqual(8)
	})
})
