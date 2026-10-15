import { describe, expect, it } from 'vitest'
import {
	currentBusinessDate,
	formatHhmm,
	instantToLocal,
	localToInstant,
	parseHhmm,
	resolveServiceWindow,
} from './time.ts'

describe('reservations DST-safe time math', () => {
	it('resolves US spring-forward gap (America/New_York 2026-03-08 02:30) to post-gap EDT instant', () => {
		const res = localToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York')
		// 02:30 EST (UTC-5) shifts forward to 03:30 EDT (UTC-4) = 07:30 UTC
		expect(res.instantMs).toBe(Date.parse('2026-03-08T07:30:00.000Z'))
		expect(res.adjustedForGap).toBe(true)
		expect(res.ambiguousFold).toBe(false)
	})

	it('resolves US fall-back fold (America/New_York 2026-11-01 01:30) to first occurrence (EDT)', () => {
		const res = localToInstant('2026-11-01', 1 * 60 + 30, 'America/New_York')
		// First 01:30 is EDT (UTC-4) = 05:30 UTC; second is EST (UTC-5) = 06:30 UTC
		expect(res.instantMs).toBe(Date.parse('2026-11-01T05:30:00.000Z'))
		expect(res.adjustedForGap).toBe(false)
		expect(res.ambiguousFold).toBe(true)
	})

	it('resolves America/Los_Angeles spring-forward and fall-back transitions', () => {
		const gap = localToInstant('2026-03-08', 2 * 60 + 15, 'America/Los_Angeles')
		// 02:15 PST (UTC-8) -> 03:15 PDT (UTC-7) = 10:15 UTC
		expect(gap.instantMs).toBe(Date.parse('2026-03-08T10:15:00.000Z'))
		expect(gap.adjustedForGap).toBe(true)

		const fold = localToInstant(
			'2026-11-01',
			1 * 60 + 15,
			'America/Los_Angeles',
		)
		// First 01:15 PDT (UTC-7) = 08:15 UTC
		expect(fold.instantMs).toBe(Date.parse('2026-11-01T08:15:00.000Z'))
		expect(fold.ambiguousFold).toBe(true)
	})

	it('resolves UK BST spring-forward (2026-03-29 01:30) and autumn fall-back (2026-10-25 01:30)', () => {
		const ukGap = localToInstant('2026-03-29', 1 * 60 + 30, 'Europe/London')
		// Clocks jump 01:00 GMT -> 02:00 BST; 01:30 resolves to 01:30 UTC (02:30 BST)
		expect(ukGap.instantMs).toBe(Date.parse('2026-03-29T01:30:00.000Z'))
		expect(ukGap.adjustedForGap).toBe(true)

		const ukFold = localToInstant('2026-10-25', 1 * 60 + 30, 'Europe/London')
		// First 01:30 is BST (UTC+1) = 00:30 UTC; second is GMT (UTC+0) = 01:30 UTC
		expect(ukFold.instantMs).toBe(Date.parse('2026-10-25T00:30:00.000Z'))
		expect(ukFold.ambiguousFold).toBe(true)
	})

	it('resolves Asia/Riyadh midnight-crossing services (localStartMin >= 1440) and dayStartMin rollover', () => {
		// 01:30 AM on the morning of 2026-06-11 belonging to businessDate 2026-06-10 (localStartMin = 1530)
		const late = localToInstant('2026-06-10', 25 * 60 + 30, 'Asia/Riyadh')
		// 2026-06-11 01:30 AST (UTC+3) = 2026-06-10T22:30:00.000Z
		expect(late.instantMs).toBe(Date.parse('2026-06-10T22:30:00.000Z'))
		expect(late.adjustedForGap).toBe(false)
		expect(late.ambiguousFold).toBe(false)

		// With dayStartMin = 240 (04:00 AM), instantToLocal maps 01:30 AM on 2026-06-11 back to businessDate 2026-06-10, localStartMin 1530
		const back = instantToLocal(late.instantMs, 'Asia/Riyadh', 240)
		expect(back).toEqual({
			businessDate: '2026-06-10',
			localStartMin: 25 * 60 + 30,
			calendarDate: '2026-06-11',
			clockMin: 90,
		})

		// currentBusinessDate before 04:00 AM belongs to previous business date
		expect(currentBusinessDate(late.instantMs, 'Asia/Riyadh', 240)).toBe(
			'2026-06-10',
		)
		// At 04:00 AM on 2026-06-11 it rolls over to 2026-06-11
		const fourAm = localToInstant('2026-06-11', 240, 'Asia/Riyadh').instantMs
		expect(currentBusinessDate(fourAm, 'Asia/Riyadh', 240)).toBe('2026-06-11')
	})

	it('computes accurate service windows across midnight and DST changes', () => {
		const riyadhDinner = resolveServiceWindow(
			'2026-06-10',
			18 * 60,
			26 * 60, // 02:00 next morning
			'Asia/Riyadh',
		)
		expect(riyadhDinner.startMs).toBe(Date.parse('2026-06-10T15:00:00.000Z'))
		expect(riyadhDinner.endMs).toBe(Date.parse('2026-06-10T23:00:00.000Z'))
		expect(riyadhDinner.durationMin).toBe(8 * 60)

		expect(formatHhmm(18 * 60 + 30)).toBe('18:30')
		expect(formatHhmm(25 * 60 + 5)).toBe('01:05')
		expect(parseHhmm('18:30')).toBe(18 * 60 + 30)
	})
})
