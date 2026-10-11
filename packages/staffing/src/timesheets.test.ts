import { describe, expect, it } from 'vitest'
import {
	entryPaidMinutes,
	timeEntryInstants,
	timeEntryIssues,
	timesheetQuerySchema,
	weeklyTotals,
} from './timesheets.ts'

const at = (iso: string) => new Date(iso)

describe('timesheets', () => {
	it('resolves wall-clock card times, including overnight and DST nights', () => {
		expect(
			timeEntryInstants(
				{ localDate: '2026-10-12', clockIn: '09:00', clockOut: '17:30' },
				'America/New_York',
			),
		).toEqual({
			clockInAt: at('2026-10-12T13:00:00Z'),
			clockOutAt: at('2026-10-12T21:30:00Z'),
		})
		// Clocks fall back at 02:00 on 2026-11-01: 22:00–06:00 is 9 real hours.
		const night = timeEntryInstants(
			{ localDate: '2026-10-31', clockIn: '22:00', clockOut: '06:00' },
			'America/New_York',
		)
		expect(entryPaidMinutes({ ...night, unpaidBreakMinutes: 30 })).toBe(
			9 * 60 - 30,
		)
		expect(
			timeEntryInstants(
				{ localDate: '2026-10-12', clockIn: '09:00', clockOut: null },
				'Asia/Riyadh',
			),
		).toEqual({ clockInAt: at('2026-10-12T06:00:00Z'), clockOutAt: null })
	})

	it('flags missing clock-outs, unscheduled, and late cards', () => {
		const now = at('2026-10-13T12:00:00Z')
		const options = { lateGraceMinutes: 5, now }
		expect(
			timeEntryIssues(
				{ clockInAt: at('2026-10-12T13:00:00Z'), clockOutAt: null },
				null,
				options,
			),
		).toEqual(['missing_clock_out', 'unscheduled'])
		expect(
			timeEntryIssues(
				{ clockInAt: at('2026-10-13T08:00:00Z'), clockOutAt: null },
				{ startAt: at('2026-10-13T08:00:00Z') },
				options,
			),
		).toEqual([])
		const scheduled = { startAt: at('2026-10-12T13:00:00Z') }
		const card = (iso: string) => ({
			clockInAt: at(iso),
			clockOutAt: at('2026-10-12T21:00:00Z'),
		})
		expect(
			timeEntryIssues(card('2026-10-12T13:05:00Z'), scheduled, options),
		).toEqual([])
		expect(
			timeEntryIssues(card('2026-10-12T13:06:00Z'), scheduled, options),
		).toEqual(['late'])
	})

	it('splits weekly totals per person at the threshold by configured week', () => {
		const entries = [
			// Sunday 2026-10-11 belongs to the previous Monday week.
			{ staffId: 'a', localDate: '2026-10-11', paidMinutes: 600 },
			{ staffId: 'a', localDate: '2026-10-12', paidMinutes: 1500 },
			{ staffId: 'a', localDate: '2026-10-13', paidMinutes: 1200 },
			{ staffId: 'b', localDate: '2026-10-13', paidMinutes: 60 },
		]
		expect(
			weeklyTotals(entries, { weekStart: 'monday', weeklyHoursThreshold: 40 }),
		).toEqual([
			{
				staffId: 'a',
				weekStart: '2026-10-05',
				paidMinutes: 600,
				regularMinutes: 600,
				overThresholdMinutes: 0,
			},
			{
				staffId: 'a',
				weekStart: '2026-10-12',
				paidMinutes: 2700,
				regularMinutes: 2400,
				overThresholdMinutes: 300,
			},
			{
				staffId: 'b',
				weekStart: '2026-10-12',
				paidMinutes: 60,
				regularMinutes: 60,
				overThresholdMinutes: 0,
			},
		])
		expect(
			weeklyTotals(entries, { weekStart: 'sunday', weeklyHoursThreshold: null })
				.filter((week) => week.staffId === 'a')
				.map((week) => [week.weekStart, week.overThresholdMinutes]),
		).toEqual([['2026-10-11', 0]])
	})

	it('caps the query range', () => {
		const query = { locationId: 'loc', from: '2026-10-01', to: '2026-10-31' }
		expect(timesheetQuerySchema.safeParse(query).success).toBe(true)
		expect(
			timesheetQuerySchema.safeParse({ ...query, to: '2026-11-01' }).success,
		).toBe(false)
		expect(
			timesheetQuerySchema.safeParse({ ...query, to: '2026-09-30' }).success,
		).toBe(false)
	})
})
