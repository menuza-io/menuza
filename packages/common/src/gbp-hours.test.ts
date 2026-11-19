import { describe, expect, it } from 'vitest'
import {
	desiredOpenStatus,
	diffSpecialHours,
	diffWeeklyHours,
	fingerprint,
	googleSpecialToMenuza,
	phonesEqual,
	specialHoursToGoogle,
	weeklyHoursEqual,
	weeklyToGooglePeriods,
} from './gbp-hours.ts'
import { type WeeklySchedule } from './location-types.ts'

const day = (
	name: WeeklySchedule[number]['day'],
	slots: Array<[string, string]>,
): WeeklySchedule[number] => ({
	day: name,
	isOpen: slots.length > 0,
	slots: slots.map(([start, end]) => ({ start, end })),
})

const week = (
	overrides: Partial<Record<string, Array<[string, string]>>> = {},
) =>
	(
		[
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
			'sunday',
		] as const
	).map((name) => day(name, overrides[name] ?? [['11:00', '22:00']]))

describe('weeklyToGooglePeriods', () => {
	it('sends one period per open slot with the right days', () => {
		const periods = weeklyToGooglePeriods(week({ sunday: [] }))
		expect(periods).toHaveLength(6)
		expect(periods[0]).toEqual({
			openDay: 'MONDAY',
			openTime: { hours: 11, minutes: 0 },
			closeDay: 'MONDAY',
			closeTime: { hours: 22, minutes: 0 },
		})
	})

	it('sends overnight hours (18:00 to 02:00) as ONE period closing the next day', () => {
		const periods = weeklyToGooglePeriods(
			week({ friday: [['18:00', '02:00']] }),
		)
		const friday = periods.find((period) => period.openDay === 'FRIDAY')
		expect(friday).toEqual({
			openDay: 'FRIDAY',
			openTime: { hours: 18, minutes: 0 },
			closeDay: 'SATURDAY',
			closeTime: { hours: 2, minutes: 0 },
		})
	})

	it('joins a stretch Menuza stored split at midnight into one period', () => {
		const periods = weeklyToGooglePeriods(
			week({
				friday: [['18:00', '23:59']],
				saturday: [['00:00', '02:30']],
			}),
		)
		const friday = periods.find((period) => period.openDay === 'FRIDAY')
		expect(friday?.closeDay).toBe('SATURDAY')
		expect(friday?.closeTime).toEqual({ hours: 2, minutes: 30 })
		expect(
			periods.filter((period) => period.openDay === 'SATURDAY'),
		).toHaveLength(0)
	})

	it('wraps Sunday night into Monday', () => {
		const periods = weeklyToGooglePeriods(
			week({ sunday: [['20:00', '01:00']] }),
		)
		const sunday = periods.find((period) => period.openDay === 'SUNDAY')
		expect(sunday?.closeDay).toBe('MONDAY')
	})

	it('closes exactly at midnight as 24:00 on the same day', () => {
		const periods = weeklyToGooglePeriods(
			week({ friday: [['11:00', '24:00']] }),
		)
		expect(periods.find((p) => p.openDay === 'FRIDAY')?.closeTime).toEqual({
			hours: 24,
			minutes: 0,
		})
	})
})

describe('diffWeeklyHours', () => {
	const google = weeklyToGooglePeriods(week())

	it('treats an overnight stretch split on one side and joined on the other as equal', () => {
		const split = week({
			friday: [['18:00', '23:59']],
			saturday: [
				['00:00', '02:30'],
				['11:00', '22:00'],
			],
		})
		const joined = weeklyToGooglePeriods(
			week({ friday: [['18:00', '02:30']], saturday: [['11:00', '22:00']] }),
		)
		expect(weeklyHoursEqual(split, joined)).toBe(true)
	})

	it('names the differing day in plain words', () => {
		const differences = diffWeeklyHours(
			week({ friday: [['11:00', '23:00']] }),
			google,
		)
		expect(differences).toEqual([
			{
				day: 'friday',
				label: 'Fri',
				menuza: '11:00-23:00',
				google: '11:00-22:00',
			},
		])
	})

	it('reports a day Google has closed', () => {
		const differences = diffWeeklyHours(
			week(),
			weeklyToGooglePeriods(week({ monday: [] })),
		)
		expect(differences[0]).toMatchObject({ day: 'monday', google: 'Closed' })
	})
})

describe('special hours', () => {
	const today = '2026-12-20'
	const special = [
		{ id: 'a', date: '2026-12-25', isOpen: false, slots: [] },
		{
			id: 'b',
			date: '2026-12-31',
			isOpen: true,
			slots: [{ start: '18:00', end: '02:00' }],
		},
		{ id: 'c', date: '2026-12-01', isOpen: false, slots: [] },
	]

	it('sends today and future dates only', () => {
		const periods = specialHoursToGoogle(special, today)
		expect(periods.map((p) => p.startDate.day)).toEqual([25, 31])
		expect(periods[0]).toEqual({
			startDate: { year: 2026, month: 12, day: 25 },
			closed: true,
		})
	})

	it('ends an overnight special day on the next date', () => {
		const [, overnight] = specialHoursToGoogle(special, today)
		expect(overnight?.endDate).toEqual({ year: 2027, month: 1, day: 1 })
		expect(overnight?.closeTime).toEqual({ hours: 2, minutes: 0 })
	})

	it('reports a missing holiday and ignores past dates', () => {
		const differences = diffSpecialHours(special, [], today)
		expect(differences.map((d) => d.date)).toEqual(['2026-12-25', '2026-12-31'])
		expect(
			diffSpecialHours(special, specialHoursToGoogle(special, today), today),
		).toEqual([])
	})

	it('turns Google special hours back into Menuza entries and leaves past dates alone', () => {
		const result = googleSpecialToMenuza(
			[{ startDate: { year: 2026, month: 12, day: 24 }, closed: true }],
			today,
			special,
		)
		expect(result.find((item) => item.date === '2026-12-01')).toBeDefined()
		expect(result.find((item) => item.date === '2026-12-24')?.isOpen).toBe(
			false,
		)
		expect(result.find((item) => item.date === '2026-12-25')).toBeUndefined()
	})
})

describe('open state, phone and fingerprints', () => {
	const now = new Date('2026-12-20T12:00:00Z')
	it('closes temporarily until the end date, then reopens', () => {
		const until = new Date('2026-12-22T00:00:00Z')
		expect(
			desiredOpenStatus(
				{ temporarilyClosed: true, temporarilyClosedUntil: until },
				now,
			),
		).toBe('CLOSED_TEMPORARILY')
		expect(
			desiredOpenStatus(
				{ temporarilyClosed: true, temporarilyClosedUntil: null },
				now,
			),
		).toBe('CLOSED_TEMPORARILY')
		expect(
			desiredOpenStatus(
				{ temporarilyClosed: true, temporarilyClosedUntil: until },
				new Date('2026-12-23T00:00:00Z'),
			),
		).toBe('OPEN')
		expect(
			desiredOpenStatus(
				{ temporarilyClosed: false, temporarilyClosedUntil: null },
				now,
			),
		).toBe('OPEN')
	})

	it('compares phones by digits and tolerates a country code', () => {
		expect(phonesEqual('+1 (555) 010-0', '+1-555-0100')).toBe(true)
		expect(phonesEqual('555-0100', '+1-555-0100')).toBe(true)
		expect(phonesEqual('555-0100', '555-0199')).toBe(false)
	})

	it('fingerprints equal values equally whatever the key order', () => {
		expect(fingerprint({ a: 1, b: [1, 2] })).toBe(
			fingerprint({ b: [1, 2], a: 1 }),
		)
		expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
	})
})
