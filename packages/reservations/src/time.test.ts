import { describe, expect, it } from 'vitest'
import {
	type LocalToInstantOptions,
	currentBusinessDate,
	formatHhmm,
	instantToLocal,
	localToInstant,
	parseHhmm,
	resolveServiceWindow,
} from './time.ts'

describe('reservations DST-safe time math', () => {
	it('resolves US spring-forward gap (America/New_York 2026-03-08 & 2027-03-14 02:30) with gap: skip vs after', () => {
		const widenedOpts: LocalToInstantOptions | undefined = { gap: 'skip' }
		const widenedRes = localToInstant(
			'2027-03-14',
			2 * 60 + 30,
			'America/New_York',
			widenedOpts,
		)
		const _nullCheck: null extends typeof widenedRes ? true : false = true
		expect(_nullCheck).toBe(true)
		expect(widenedRes).toBeNull()

		const res = localToInstant('2026-03-08', 2 * 60 + 30, 'America/New_York')
		// 02:30 EST (UTC-5) shifts forward to 03:30 EDT (UTC-4) = 07:30 UTC
		expect(res.instantMs).toBe(Date.parse('2026-03-08T07:30:00.000Z'))
		expect(res.adjustedForGap).toBe(true)
		expect(res.ambiguousFold).toBe(false)

		// Contract DST date 2027-03-14 in America/New_York & America/Los_Angeles
		expect(
			localToInstant('2027-03-14', 2 * 60, 'America/New_York', {
				gap: 'skip',
			}),
		).toBeNull()
		expect(
			localToInstant('2027-03-14', 2 * 60 + 30, 'America/New_York', {
				gap: 'skip',
			}),
		).toBeNull()
		const afterNy = localToInstant(
			'2027-03-14',
			2 * 60 + 30,
			'America/New_York',
			{ gap: 'after' },
		)
		expect(afterNy?.instantMs).toBe(Date.parse('2027-03-14T07:30:00.000Z'))
		expect(afterNy?.adjustedForGap).toBe(true)

		expect(
			localToInstant('2027-03-14', 2 * 60 + 15, 'America/Los_Angeles', {
				gap: 'skip',
			}),
		).toBeNull()
		expect(
			localToInstant('2027-03-14', 2 * 60 + 15, 'America/Los_Angeles', {
				gap: 'after',
			})?.instantMs,
		).toBe(Date.parse('2027-03-14T10:15:00.000Z'))
	})

	it('resolves US fall-back fold (America/New_York 2026-11-01 01:30 & 90-min fold) with overlap: earlier vs later', () => {
		const res = localToInstant('2026-11-01', 1 * 60 + 30, 'America/New_York')
		// First 01:30 is EDT (UTC-4) = 05:30 UTC; second is EST (UTC-5) = 06:30 UTC
		expect(res.instantMs).toBe(Date.parse('2026-11-01T05:30:00.000Z'))
		expect(res.adjustedForGap).toBe(false)
		expect(res.ambiguousFold).toBe(true)

		const earlier = localToInstant(
			'2026-11-01',
			1 * 60 + 30,
			'America/New_York',
			{ overlap: 'earlier' },
		)
		const later = localToInstant(
			'2026-11-01',
			1 * 60 + 30,
			'America/New_York',
			{ overlap: 'later' },
		)
		expect(earlier.instantMs).toBe(Date.parse('2026-11-01T05:30:00.000Z'))
		expect(later.instantMs).toBe(Date.parse('2026-11-01T06:30:00.000Z'))

		// 90-minute reservation starting at first 01:15 on fall-back day ends at second 01:45
		const start0115 = localToInstant('2026-11-01', 75, 'America/New_York', {
			overlap: 'earlier',
		})
		const end90 = start0115.instantMs + 90 * 60_000
		const second0145 = localToInstant('2026-11-01', 105, 'America/New_York', {
			overlap: 'later',
		})
		expect(end90).toBe(second0145.instantMs)
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
		expect(
			localToInstant('2026-11-01', 1 * 60 + 15, 'America/Los_Angeles', {
				overlap: 'later',
			}).instantMs,
		).toBe(Date.parse('2026-11-01T09:15:00.000Z'))
	})

	it('resolves UK BST spring-forward (2026-03-29 & 2027-03-28 01:30) and autumn fall-back (2026-10-25 01:30)', () => {
		const ukGap = localToInstant('2026-03-29', 1 * 60 + 30, 'Europe/London')
		// Clocks jump 01:00 GMT -> 02:00 BST; 01:30 resolves to 01:30 UTC (02:30 BST)
		expect(ukGap.instantMs).toBe(Date.parse('2026-03-29T01:30:00.000Z'))
		expect(ukGap.adjustedForGap).toBe(true)

		// Contract 2027-03-28 spring-forward in Europe/London
		expect(
			localToInstant('2027-03-28', 1 * 60 + 30, 'Europe/London', {
				gap: 'skip',
			}),
		).toBeNull()
		expect(
			localToInstant('2027-03-28', 1 * 60 + 30, 'Europe/London', {
				gap: 'after',
			})?.instantMs,
		).toBe(Date.parse('2027-03-28T01:30:00.000Z'))

		const ukFold = localToInstant('2026-10-25', 1 * 60 + 30, 'Europe/London')
		// First 01:30 is BST (UTC+1) = 00:30 UTC; second is GMT (UTC+0) = 01:30 UTC
		expect(ukFold.instantMs).toBe(Date.parse('2026-10-25T00:30:00.000Z'))
		expect(ukFold.ambiguousFold).toBe(true)
		expect(
			localToInstant('2026-10-25', 1 * 60 + 30, 'Europe/London', {
				overlap: 'later',
			}).instantMs,
		).toBe(Date.parse('2026-10-25T01:30:00.000Z'))
	})

	it('resolves Asia/Riyadh midnight-crossing services (localStartMin >= 1440) and dayStartMin rollover (240 ± 1 min)', () => {
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

		// dayStartMin = 240 ± 1 min boundary
		const at239 = localToInstant('2026-06-11', 239, 'Asia/Riyadh').instantMs
		const at240 = localToInstant('2026-06-11', 240, 'Asia/Riyadh').instantMs
		const at241 = localToInstant('2026-06-11', 241, 'Asia/Riyadh').instantMs
		expect(instantToLocal(at239, 'Asia/Riyadh', 240)).toMatchObject({
			businessDate: '2026-06-10',
			localStartMin: 1679,
		})
		expect(instantToLocal(at240, 'Asia/Riyadh', 240)).toMatchObject({
			businessDate: '2026-06-11',
			localStartMin: 240,
		})
		expect(instantToLocal(at241, 'Asia/Riyadh', 240)).toMatchObject({
			businessDate: '2026-06-11',
			localStartMin: 241,
		})

		// currentBusinessDate before 04:00 AM belongs to previous business date
		expect(currentBusinessDate(late.instantMs, 'Asia/Riyadh', 240)).toBe(
			'2026-06-10',
		)
		// At 04:00 AM on 2026-06-11 it rolls over to 2026-06-11
		expect(currentBusinessDate(at240, 'Asia/Riyadh', 240)).toBe('2026-06-11')
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
