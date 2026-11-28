import { describe, expect, it } from 'vitest'
import { isLocationOpenAt, parseLocationHours, ruleForDate } from './hours.ts'
import {
	expandSpecialHours,
	findSpecialHourForDate,
	isCalendarDate,
	nextSpecialHourDate,
} from './special-hours.ts'

const christmas = {
	id: 'xmas',
	date: '2026-12-25',
	isOpen: false,
	slots: [],
	repeatsYearly: true,
	note: 'Christmas',
}

describe('findSpecialHourForDate', () => {
	it('applies a repeating entry on the same month and day of later years', () => {
		expect(findSpecialHourForDate([christmas], '2027-12-25')).toBe(christmas)
		expect(findSpecialHourForDate([christmas], '2031-12-25')).toBe(christmas)
		expect(findSpecialHourForDate([christmas], '2027-12-24')).toBeUndefined()
	})

	it('never applies a repeating entry before its own year', () => {
		expect(findSpecialHourForDate([christmas], '2025-12-25')).toBeUndefined()
	})

	it('lets a one-off entry for the same date beat the repeating one, for that year only', () => {
		const oneOff = {
			id: 'x',
			date: '2027-12-25',
			isOpen: true,
			slots: [{ start: '12:00', end: '16:00' }],
		}
		expect(findSpecialHourForDate([christmas, oneOff], '2027-12-25')).toBe(
			oneOff,
		)
		expect(findSpecialHourForDate([oneOff, christmas], '2027-12-25')).toBe(
			oneOff,
		)
		expect(findSpecialHourForDate([christmas, oneOff], '2028-12-25')).toBe(
			christmas,
		)
	})

	it('prefers the latest-started repeating entry', () => {
		const older = { ...christmas, id: 'old', date: '2024-12-25', isOpen: true }
		expect(findSpecialHourForDate([older, christmas], '2027-12-25')?.id).toBe(
			'xmas',
		)
	})

	it('repeats 29 February only in leap years', () => {
		const leap = {
			id: 'l',
			date: '2028-02-29',
			isOpen: false,
			repeatsYearly: true,
		}
		expect(findSpecialHourForDate([leap], '2032-02-29')).toBe(leap)
		expect(findSpecialHourForDate([leap], '2029-02-28')).toBeUndefined()
		expect(findSpecialHourForDate([leap], '2029-03-01')).toBeUndefined()
	})
})

describe('nextSpecialHourDate', () => {
	it('returns the entry date while it is ahead, and the next year when it has passed', () => {
		expect(nextSpecialHourDate(christmas, '2026-06-01')).toBe('2026-12-25')
		expect(nextSpecialHourDate(christmas, '2026-12-26')).toBe('2027-12-25')
		expect(nextSpecialHourDate(christmas, '2026-12-25')).toBe('2026-12-25')
	})

	it('has no next date for a past one-off entry', () => {
		expect(nextSpecialHourDate({ date: '2020-01-01' }, '2026-01-01')).toBeNull()
	})

	it('skips to the next leap year for 29 February', () => {
		expect(
			nextSpecialHourDate(
				{ date: '2024-02-29', repeatsYearly: true },
				'2025-01-01',
			),
		).toBe('2028-02-29')
	})
})

describe('expandSpecialHours', () => {
	it('turns a repeating entry into one dated entry per year in the range', () => {
		const expanded = expandSpecialHours([christmas], '2026-12-01', '2028-12-31')
		expect(expanded.map((entry) => entry.date)).toEqual([
			'2026-12-25',
			'2027-12-25',
			'2028-12-25',
		])
		expect(expanded.every((entry) => !('repeatsYearly' in entry))).toBe(true)
	})

	it('lets an exact-year entry replace the repeating one on that date', () => {
		const oneOff = {
			id: 'x',
			date: '2027-12-25',
			isOpen: true,
			slots: [{ start: '12:00', end: '16:00' }],
		}
		const expanded = expandSpecialHours(
			[christmas, oneOff],
			'2026-12-01',
			'2028-12-31',
		)
		expect(expanded.find((entry) => entry.date === '2027-12-25')?.isOpen).toBe(
			true,
		)
		expect(expanded.find((entry) => entry.date === '2028-12-25')?.isOpen).toBe(
			false,
		)
	})

	it('drops past one-offs and keeps a window across the year boundary', () => {
		const newYear = {
			id: 'ny',
			date: '2027-01-01',
			isOpen: false,
			repeatsYearly: true,
		}
		const expanded = expandSpecialHours(
			[newYear, { id: 'p', date: '2020-05-05', isOpen: false }],
			'2026-12-30',
			'2027-01-02',
		)
		expect(expanded.map((entry) => entry.date)).toEqual(['2027-01-01'])
	})
})

describe('isCalendarDate', () => {
	it('rejects impossible dates', () => {
		expect(isCalendarDate('2027-02-29')).toBe(false)
		expect(isCalendarDate('2028-02-29')).toBe(true)
		expect(isCalendarDate('2026-13-01')).toBe(false)
	})
})

describe('hours module reads repeating entries (#242)', () => {
	const weekly = [
		'sunday',
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
	].map((day) => ({
		day,
		isOpen: true,
		slots: [{ start: '09:00', end: '21:00' }],
	}))
	const { hours } = parseLocationHours({
		timeZone: 'America/New_York',
		storeHours: weekly,
		specialHours: [christmas],
	})
	// Noon in New York on 25 December 2027.
	const nextChristmasNoon = Date.UTC(2027, 11, 25, 17, 0)

	it('closes ordering next year without anyone re-entering the closure', () => {
		expect(isLocationOpenAt(hours, nextChristmasNoon)).toMatchObject({
			open: false,
			reason: 'special_closed',
			note: 'Christmas',
		})
		expect(ruleForDate(hours, '2027-12-25')).toMatchObject({
			kind: 'closed',
		})
	})

	it('stays open the day after', () => {
		expect(isLocationOpenAt(hours, nextChristmasNoon + 86_400_000).open).toBe(
			true,
		)
	})

	it('keeps the flag when parsing stored JSON', () => {
		expect(hours.specialHours?.[0]?.repeatsYearly).toBe(true)
	})

	it('lets a one-off entry override it for that year only', () => {
		const { hours: withOverride } = parseLocationHours({
			timeZone: 'America/New_York',
			storeHours: weekly,
			specialHours: [
				christmas,
				{
					id: 'open',
					date: '2027-12-25',
					isOpen: true,
					slots: [{ start: '12:00', end: '16:00' }],
				},
			],
		})
		expect(isLocationOpenAt(withOverride, nextChristmasNoon).open).toBe(true)
		// A year later the repeating closure rules again.
		expect(
			isLocationOpenAt(withOverride, Date.UTC(2028, 11, 25, 17, 0)).open,
		).toBe(false)
	})

	it('repeats 29 February only in leap years', () => {
		const { hours: leapHours } = parseLocationHours({
			timeZone: 'UTC',
			storeHours: weekly,
			specialHours: [
				{
					id: 'l',
					date: '2028-02-29',
					isOpen: false,
					slots: [],
					repeatsYearly: true,
				},
			],
		})
		expect(isLocationOpenAt(leapHours, Date.UTC(2032, 1, 29, 12)).open).toBe(
			false,
		)
		expect(isLocationOpenAt(leapHours, Date.UTC(2029, 1, 28, 12)).open).toBe(
			true,
		)
		expect(isLocationOpenAt(leapHours, Date.UTC(2029, 2, 1, 12)).open).toBe(
			true,
		)
	})
})
