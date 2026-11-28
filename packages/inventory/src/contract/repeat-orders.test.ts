import { describe, expect, it } from 'vitest'
import {
	findDueRepeatDeliveryDate,
	formatHolidaySkipNote,
	isCadenceMatch,
	isWithinDraftWindow,
	parseClosedSpecialDates,
	repeatOrderCutoffFor,
	upcomingRepeatDeliveryDates,
} from './repeat-orders.ts'

describe('repeat-orders schedule helpers', () => {
	it('computes default cutoff when supplier has no cutoffTime', () => {
		expect(
			repeatOrderCutoffFor('2026-11-25', {
				cutoffTime: null,
				cutoffDaysBefore: null,
			}),
		).toEqual({ date: '2026-11-24', time: '16:00' })
	})

	it('uses supplier cutoffTime and cutoffDaysBefore when set', () => {
		expect(
			repeatOrderCutoffFor('2026-11-25', {
				cutoffTime: '11:30',
				cutoffDaysBefore: 2,
			}),
		).toEqual({ date: '2026-11-23', time: '11:30' })
	})

	it('checks pre-cutoff draft window accurately', () => {
		const cutoff = { date: '2026-11-24', time: '16:00' }
		// 24h before cutoff -> inside
		expect(
			isWithinDraftWindow(cutoff, { date: '2026-11-23', time: '16:00' }),
		).toBe(true)
		// 24h + 1m before cutoff -> outside
		expect(
			isWithinDraftWindow(cutoff, { date: '2026-11-23', time: '15:59' }),
		).toBe(false)
		// Exactly at cutoff -> inside
		expect(
			isWithinDraftWindow(cutoff, { date: '2026-11-24', time: '16:00' }),
		).toBe(true)
		// 1m after cutoff -> outside
		expect(
			isWithinDraftWindow(cutoff, { date: '2026-11-24', time: '16:01' }),
		).toBe(false)
	})

	it('matches 1-week, 2-week, and 4-week cadences', () => {
		// 2026-11-23 is Monday (weekday 1)
		expect(isCadenceMatch('2026-11-23', '2026-11-23', 1, [1, 4])).toBe(true)
		expect(isCadenceMatch('2026-11-26', '2026-11-23', 1, [1, 4])).toBe(true)
		expect(isCadenceMatch('2026-11-30', '2026-11-23', 2, [1])).toBe(false)
		expect(isCadenceMatch('2026-12-07', '2026-11-23', 2, [1])).toBe(true)
		expect(isCadenceMatch('2026-12-07', '2026-11-23', 4, [1])).toBe(false)
		expect(isCadenceMatch('2026-12-21', '2026-11-23', 4, [1])).toBe(true)
	})

	it('computes upcoming delivery dates for 2-week cadence', () => {
		const dates = upcomingRepeatDeliveryDates({
			fromDate: '2026-11-23',
			anchorDate: '2026-11-23',
			cadenceWeeks: 2,
			weekdays: [1, 4], // Mon, Thu
			count: 4,
		})
		expect(dates).toEqual([
			'2026-11-23',
			'2026-11-26',
			'2026-12-07',
			'2026-12-10',
		])
	})

	it('finds due repeat delivery date inside the pre-cutoff window', () => {
		// Thursday 2026-11-26 delivery, cutoff Wednesday 2026-11-25 14:00
		const due = findDueRepeatDeliveryDate({
			now: { date: '2026-11-25', time: '10:00' },
			anchorDate: '2026-11-23',
			cadenceWeeks: 1,
			weekdays: [4],
			schedule: { cutoffTime: '14:00', cutoffDaysBefore: 1 },
		})
		expect(due).toEqual({
			deliveryDate: '2026-11-26',
			cutoff: { date: '2026-11-25', time: '14:00' },
		})

		// After cutoff -> null
		const after = findDueRepeatDeliveryDate({
			now: { date: '2026-11-25', time: '14:05' },
			anchorDate: '2026-11-23',
			cadenceWeeks: 1,
			weekdays: [4],
			schedule: { cutoffTime: '14:00', cutoffDaysBefore: 1 },
		})
		expect(after).toBeNull()
	})

	it('parses closed special hours in both LocationSpecialHour and closed/reason formats', () => {
		const map = parseClosedSpecialDates(
			JSON.stringify([
				{
					id: '1',
					date: '2026-12-25',
					isOpen: false,
					slots: [],
					note: 'Christmas',
				},
				{
					date: '2026-12-26',
					isOpen: true,
					slots: [{ open: '09:00', close: '17:00' }],
				},
				{ date: '2027-01-01', closed: true, reason: 'New Year' },
			]),
		)
		expect(map.get('2026-12-25')).toBe('Christmas')
		expect(map.has('2026-12-26')).toBe(false)
		expect(map.get('2027-01-01')).toBe('New Year')
		expect(formatHolidaySkipNote('Christmas')).toBe(
			'Skipped: closed for holiday (Christmas)',
		)
		expect(formatHolidaySkipNote(null)).toBe('Skipped: closed for holiday')
	})
})

describe('parseClosedSpecialDates with yearly repeats (#242)', () => {
	it('expands a repeating closure over the asked range', () => {
		const map = parseClosedSpecialDates(
			[
				{
					date: '2026-12-25',
					isOpen: false,
					repeatsYearly: true,
					note: 'Christmas',
				},
			],
			{ from: '2027-12-01', to: '2027-12-31' },
		)
		expect([...map.entries()]).toEqual([['2027-12-25', 'Christmas']])
	})
})
