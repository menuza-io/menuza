import { describe, expect, it } from 'vitest'
import {
	availabilityWhen,
	emptyDays,
	formatMinute,
	invalidDays,
	timeOffDays,
	timeOffWhen,
	weekdayName,
	weeklyRows,
} from './schedule-requests.ts'
import { type AvailabilityRow, type TimeOffRow } from './schedule-types.ts'

const timeOff = (extra: Partial<TimeOffRow> = {}): TimeOffRow => ({
	id: 't1',
	staffId: 's1',
	category: 'pto',
	startDate: '2026-03-02',
	endDate: '2026-03-02',
	allDay: true,
	startMinute: null,
	endMinute: null,
	note: null,
	status: 'pending',
	source: 'staff',
	decidedBy: null,
	decidedAt: null,
	decisionNote: null,
	createdAt: 0,
	warnings: [],
	...extra,
})

const availability = (
	extra: Partial<AvailabilityRow> = {},
): AvailabilityRow => ({
	id: 'a1',
	staffId: 's1',
	kind: 'weekly',
	weekday: 1,
	date: null,
	availability: 'available',
	allDay: false,
	startMinute: 540,
	endMinute: 1020,
	effectiveFrom: null,
	effectiveTo: null,
	note: null,
	status: 'pending',
	source: 'staff',
	decidedBy: null,
	decidedAt: null,
	decisionNote: null,
	createdAt: 0,
	...extra,
})

describe('minutes and weekdays', () => {
	it('reads the end of the day as midnight', () => {
		expect(formatMinute(540, 'en')).toMatch(/^9:00\s?AM$/)
		expect(formatMinute(1440, 'en')).toMatch(/^12:00\s?AM$/)
	})

	it('names weekdays from a Sunday-first number', () => {
		expect(weekdayName(0, 'en')).toBe('Sunday')
		expect(weekdayName(1, 'en')).toBe('Monday')
		expect(weekdayName(6, 'en')).toBe('Saturday')
	})
})

describe('timeOffWhen', () => {
	it('words a day, a range and part of a day', () => {
		expect(timeOffWhen(timeOff(), 'en')).toBe('Mon, Mar 2')
		expect(timeOffWhen(timeOff({ endDate: '2026-03-06' }), 'en')).toMatch(
			/^Mar 2\s*\S\s*6, 2026$/,
		)
		expect(
			timeOffWhen(
				timeOff({ allDay: false, startMinute: 840, endMinute: 1080 }),
				'en',
			),
		).toMatch(/Mon, Mar 2, 2:00\s?PM . 6:00\s?PM/)
	})

	it('counts days inclusively, across a month end', () => {
		expect(timeOffDays(timeOff())).toBe(1)
		expect(
			timeOffDays(timeOff({ startDate: '2026-02-27', endDate: '2026-03-02' })),
		).toBe(4)
	})
})

describe('availabilityWhen', () => {
	it('words a weekly window and a one-off all-day date', () => {
		expect(availabilityWhen(availability(), 'en')).toMatchObject({
			day: 'Monday',
			recurring: true,
			allDay: false,
		})
		expect(availabilityWhen(availability(), 'en').hours).toMatch(
			/9:00\s?AM . 5:00\s?PM/,
		)
		expect(
			availabilityWhen(
				availability({
					kind: 'one_off',
					weekday: null,
					date: '2026-03-05',
					allDay: true,
					startMinute: null,
					endMinute: null,
				}),
				'en',
			),
		).toEqual({
			day: 'Thu, Mar 5',
			hours: null,
			allDay: true,
			recurring: false,
		})
	})
})

describe('the availability editor', () => {
	it('starts with a Monday-first week and nothing set', () => {
		const days = emptyDays()
		expect(days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0])
		expect(weeklyRows(days)).toEqual([])
	})

	it('builds a row for each day that was filled in', () => {
		const days = emptyDays()
		days[0] = { ...days[0]!, mode: 'unavailable_all' }
		days[1] = {
			...days[1]!,
			mode: 'available_hours',
			startTime: '10:00',
			endTime: '22:00',
		}
		days[6] = { ...days[6]!, mode: 'available_all' }
		expect(weeklyRows(days, '2026-03-09')).toEqual([
			{
				kind: 'weekly',
				weekday: 1,
				availability: 'unavailable',
				allDay: true,
				effectiveFrom: '2026-03-09',
			},
			{
				kind: 'weekly',
				weekday: 2,
				availability: 'available',
				allDay: false,
				startTime: '10:00',
				endTime: '22:00',
				effectiveFrom: '2026-03-09',
			},
			{
				kind: 'weekly',
				weekday: 0,
				availability: 'available',
				allDay: true,
				effectiveFrom: '2026-03-09',
			},
		])
	})

	it('flags hours that end before they start, but accepts midnight as the end', () => {
		const days = emptyDays()
		days[2] = {
			...days[2]!,
			mode: 'unavailable_hours',
			startTime: '18:00',
			endTime: '09:00',
		}
		days[3] = {
			...days[3]!,
			mode: 'available_hours',
			startTime: '18:00',
			endTime: '24:00',
		}
		days[4] = {
			...days[4]!,
			mode: 'available_all',
			startTime: '18:00',
			endTime: '09:00',
		}
		expect(invalidDays(days)).toEqual([3])
	})
})
