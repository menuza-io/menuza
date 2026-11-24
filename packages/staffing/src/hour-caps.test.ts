import { describe, expect, it } from 'vitest'
import {
	dailyCapFor,
	detectHourCapBreaches,
	hijriMonthOf,
	isRamadanDate,
	NO_HOUR_CAPS,
	NO_PERSON_HOUR_LIMITS,
	weeklyCapFor,
} from './hour-caps.ts'
import { KSA_HOUR_CAPS } from './rules.ts'
import { startOfLocalDay } from './tz.ts'

const TZ = 'Asia/Riyadh'
const H = 60 * 60_000

function shift(
	id: string,
	date: string,
	startHour: number,
	hours: number,
	brk = 0,
) {
	const start = startOfLocalDay(date, TZ) + startHour * H
	return {
		id,
		startsAt: start,
		endsAt: start + hours * H,
		unpaidBreakMinutes: brk,
	}
}

const base = {
	timeZone: TZ,
	weekStartsOn: 6,
	workdayStartMinute: 0,
	caps: KSA_HOUR_CAPS,
	person: NO_PERSON_HOUR_LIMITS,
}

// 2026-06-02 is outside Ramadan; Ramadan 1447 ran about 2026-02-18 to 2026-03-19.
const NORMAL_DAY = '2026-06-02'
const RAMADAN_DAY = '2026-03-02'

describe('Hijri calendar', () => {
	it('finds Ramadan like prep does', () => {
		expect(hijriMonthOf('2026-02-25')).toBe(9)
		expect(isRamadanDate(RAMADAN_DAY)).toBe(true)
		expect(isRamadanDate(NORMAL_DAY)).toBe(false)
		expect(hijriMonthOf('nope')).toBeNull()
	})
})

describe('KSA caps', () => {
	it('are 8 hours a day and 48 a week, and 6 and 36 in Ramadan', () => {
		expect(KSA_HOUR_CAPS).toEqual({
			dailyMinutes: 480,
			weeklyMinutes: 2880,
			ramadanDailyMinutes: 360,
			ramadanWeeklyMinutes: 2160,
		})
	})
})

describe('detectHourCapBreaches', () => {
	it('warns on a 9th paid hour in a day', () => {
		const eight = shift('a', NORMAL_DAY, 8, 8)
		expect(detectHourCapBreaches({ ...base, shifts: [eight] })).toEqual([])
		const ninth = shift('b', NORMAL_DAY, 17, 1)
		expect(detectHourCapBreaches({ ...base, shifts: [eight, ninth] })).toEqual([
			{
				kind: 'daily',
				shiftId: 'b',
				date: NORMAL_DAY,
				capMinutes: 480,
				scheduledMinutes: 540,
			},
		])
	})

	it('does not count an unpaid break', () => {
		const long = shift('a', NORMAL_DAY, 8, 9, 60)
		expect(detectHourCapBreaches({ ...base, shifts: [long] })).toEqual([])
	})

	it('warns when a week passes 48 hours, from the shift that crosses it', () => {
		const days = [
			'2026-05-30',
			'2026-05-31',
			'2026-06-01',
			'2026-06-02',
			'2026-06-03',
			'2026-06-04',
		]
		const shifts = days.map((d, i) => shift(`s${i}`, d, 8, 8)) // 6 x 8 = 48
		expect(detectHourCapBreaches({ ...base, shifts })).toEqual([])
		const extra = shift('over', '2026-06-05', 8, 1)
		const out = detectHourCapBreaches({ ...base, shifts: [...shifts, extra] })
		expect(out).toEqual([
			expect.objectContaining({
				kind: 'weekly',
				shiftId: 'over',
				capMinutes: 2880,
			}),
		])
	})

	it('applies the Ramadan caps only to people who follow the limit', () => {
		const sixAndABit = shift('a', RAMADAN_DAY, 9, 7)
		const follows = { ...NO_PERSON_HOUR_LIMITS, followsRamadan: true }
		expect(
			detectHourCapBreaches({ ...base, shifts: [sixAndABit], person: follows }),
		).toEqual([
			expect.objectContaining({
				kind: 'daily',
				capMinutes: 360,
				scheduledMinutes: 420,
			}),
		])
		expect(detectHourCapBreaches({ ...base, shifts: [sixAndABit] })).toEqual([])
	})

	it('applies the 36 hour weekly cap in a Ramadan week to people with the flag', () => {
		// Saturday week of 2026-02-28 .. 2026-03-06, six 6.5 hour days = 39 hours.
		const days = [
			'2026-02-28',
			'2026-03-01',
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
			'2026-03-05',
		]
		const shifts = days.map((d, i) => shift(`s${i}`, d, 9, 6))
		expect(
			detectHourCapBreaches({
				...base,
				shifts,
				person: { ...NO_PERSON_HOUR_LIMITS, followsRamadan: true },
			}),
		).toEqual([])
		const seventh = shift('x', '2026-03-06', 9, 1)
		const out = detectHourCapBreaches({
			...base,
			shifts: [...shifts, seventh],
			person: { ...NO_PERSON_HOUR_LIMITS, followsRamadan: true },
		})
		expect(out).toContainEqual(
			expect.objectContaining({
				kind: 'weekly',
				shiftId: 'x',
				capMinutes: 2160,
			}),
		)
		// Without the flag the same week stays under 48 hours.
		expect(
			detectHourCapBreaches({ ...base, shifts: [...shifts, seventh] }),
		).toEqual([])
	})

	it('lets a person override the caps (a part-timer or a minor)', () => {
		const person = {
			dailyMinutes: 240,
			weeklyMinutes: 1200,
			followsRamadan: false,
		}
		const out = detectHourCapBreaches({
			...base,
			person,
			shifts: [shift('a', NORMAL_DAY, 9, 5)],
		})
		expect(out).toEqual([
			expect.objectContaining({ kind: 'daily', capMinutes: 240 }),
		])
	})

	it('reports nothing with no caps, and only the shifts asked about', () => {
		const shifts = [shift('a', NORMAL_DAY, 8, 8), shift('b', NORMAL_DAY, 17, 4)]
		expect(
			detectHourCapBreaches({ ...base, caps: NO_HOUR_CAPS, shifts }),
		).toEqual([])
		expect(
			detectHourCapBreaches({ ...base, shifts, only: new Set(['a']) }),
		).toEqual([])
		expect(
			dailyCapFor(NO_HOUR_CAPS, NO_PERSON_HOUR_LIMITS, NORMAL_DAY),
		).toBeNull()
		expect(
			weeklyCapFor(NO_HOUR_CAPS, NO_PERSON_HOUR_LIMITS, '2026-05-30'),
		).toBeNull()
	})
})
