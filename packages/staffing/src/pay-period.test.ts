import { describe, expect, it } from 'vitest'
import {
	nextPayPeriod,
	payPeriodAnchorProblem,
	payPeriodFor,
	payPeriodSettingsSchema,
	previousPayPeriod,
	type PayPeriodConfig,
} from './pay-period.ts'
import { addDays, daysBetween } from './tz.ts'

const config = (patch: Partial<PayPeriodConfig> = {}): PayPeriodConfig => ({
	type: 'weekly',
	anchor: null,
	...patch,
})

describe('payPeriodFor: weekly', () => {
	it('follows the workweek when there is no anchor', () => {
		// 2026-03-04 is a Wednesday.
		expect(payPeriodFor('2026-03-04', config({ weekStartsOn: 1 }))).toEqual({
			type: 'weekly',
			start: '2026-03-02',
			end: '2026-03-08',
			days: 7,
		})
		expect(
			payPeriodFor('2026-03-04', config({ weekStartsOn: 0 })),
		).toMatchObject({ start: '2026-03-01', end: '2026-03-07' })
		// A Sunday-week scope starts on the Sunday itself.
		expect(
			payPeriodFor('2026-03-01', config({ weekStartsOn: 0 })),
		).toMatchObject({ start: '2026-03-01' })
	})

	it('counts from the anchor, before and after it', () => {
		const c = config({ anchor: '2026-03-04' })
		expect(payPeriodFor('2026-03-04', c)).toMatchObject({
			start: '2026-03-04',
			end: '2026-03-10',
		})
		expect(payPeriodFor('2026-03-10', c).start).toBe('2026-03-04')
		expect(payPeriodFor('2026-03-11', c).start).toBe('2026-03-11')
		// Before the anchor the cadence continues backwards.
		expect(payPeriodFor('2026-03-03', c)).toMatchObject({
			start: '2026-02-25',
			end: '2026-03-03',
		})
	})
})

describe('payPeriodFor: biweekly', () => {
	it('pairs weeks from a fixed epoch so every client agrees', () => {
		const a = payPeriodFor('2026-03-04', config({ type: 'biweekly' }))
		expect(a.days).toBe(14)
		expect(daysBetween('2024-01-01', a.start) % 14).toBe(0)
		// Both dates of one period give one answer.
		expect(payPeriodFor(a.end, config({ type: 'biweekly' }))).toEqual(a)
		expect(
			payPeriodFor(addDays(a.end, 1), config({ type: 'biweekly' })).start,
		).toBe(addDays(a.end, 1))
	})

	it('honors an anchor', () => {
		const c = config({ type: 'biweekly', anchor: '2026-03-06' })
		expect(payPeriodFor('2026-03-19', c)).toMatchObject({
			start: '2026-03-06',
			end: '2026-03-19',
		})
		expect(payPeriodFor('2026-03-20', c).start).toBe('2026-03-20')
	})
})

describe('payPeriodFor: semimonthly', () => {
	const c = config({ type: 'semimonthly' })
	it('defaults to the 1st-15th and 16th-end', () => {
		expect(payPeriodFor('2026-03-01', c)).toMatchObject({
			start: '2026-03-01',
			end: '2026-03-15',
			days: 15,
		})
		expect(payPeriodFor('2026-03-15', c).end).toBe('2026-03-15')
		expect(payPeriodFor('2026-03-16', c)).toMatchObject({
			start: '2026-03-16',
			end: '2026-03-31',
			days: 16,
		})
	})

	it('handles February, leap years and year ends', () => {
		expect(payPeriodFor('2026-02-20', c)).toMatchObject({
			start: '2026-02-16',
			end: '2026-02-28',
		})
		expect(payPeriodFor('2028-02-20', c).end).toBe('2028-02-29')
		expect(payPeriodFor('2026-12-31', c)).toMatchObject({
			start: '2026-12-16',
			end: '2026-12-31',
		})
	})

	it('uses the anchor day: boundaries on D and D + 15', () => {
		const five = config({ type: 'semimonthly', anchor: '2026-01-05' })
		expect(payPeriodFor('2026-03-05', five)).toMatchObject({
			start: '2026-03-05',
			end: '2026-03-19',
		})
		expect(payPeriodFor('2026-03-20', five)).toMatchObject({
			start: '2026-03-20',
			end: '2026-04-04',
		})
		// Before the month's first boundary the previous second half still runs.
		expect(payPeriodFor('2026-03-02', five)).toMatchObject({
			start: '2026-02-20',
			end: '2026-03-04',
		})
		expect(payPeriodFor('2026-01-02', five)).toMatchObject({
			start: '2025-12-20',
			end: '2026-01-04',
		})
	})
})

describe('payPeriodFor: monthly', () => {
	it('runs from the anchor day to the day before it next month', () => {
		const c = config({ type: 'monthly', anchor: '2026-01-10' })
		expect(payPeriodFor('2026-03-10', c)).toMatchObject({
			start: '2026-03-10',
			end: '2026-04-09',
			days: 31,
		})
		expect(payPeriodFor('2026-03-09', c)).toMatchObject({
			start: '2026-02-10',
			end: '2026-03-09',
			days: 28,
		})
		expect(payPeriodFor('2026-01-05', c)).toMatchObject({
			start: '2025-12-10',
			end: '2026-01-09',
		})
	})

	it('is calendar months when unanchored', () => {
		expect(payPeriodFor('2026-02-14', config({ type: 'monthly' }))).toEqual({
			type: 'monthly',
			start: '2026-02-01',
			end: '2026-02-28',
			days: 28,
		})
	})
})

describe('period navigation', () => {
	it('tiles the calendar with no gaps or overlaps for every type', () => {
		const types = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
		for (const type of types) {
			for (const anchor of [null, '2026-01-03', '2026-01-12']) {
				const c = config({ type, anchor, weekStartsOn: 0 })
				if (payPeriodAnchorProblem(type, anchor)) continue
				let period = payPeriodFor('2025-11-20', c)
				for (let i = 0; i < 40; i++) {
					const next = nextPayPeriod(period, c)
					expect(next.start).toBe(addDays(period.end, 1))
					expect(previousPayPeriod(next, c)).toEqual(period)
					// Every date inside maps back to this period.
					expect(payPeriodFor(period.start, c)).toEqual(period)
					expect(payPeriodFor(period.end, c)).toEqual(period)
					period = next
				}
			}
		}
	})
})

describe('anchor validation', () => {
	it('limits the day for semimonthly and monthly anchors', () => {
		expect(payPeriodAnchorProblem('semimonthly', '2026-01-15')).toBe(
			'anchor_day_unsupported',
		)
		expect(payPeriodAnchorProblem('semimonthly', '2026-01-14')).toBeNull()
		expect(payPeriodAnchorProblem('monthly', '2026-01-29')).toBe(
			'anchor_day_unsupported',
		)
		expect(payPeriodAnchorProblem('monthly', '2026-01-28')).toBeNull()
		expect(payPeriodAnchorProblem('weekly', '2026-01-31')).toBeNull()
		expect(payPeriodAnchorProblem('monthly', null)).toBeNull()
	})

	it('never throws on a stale anchor: it falls back to the default', () => {
		expect(
			payPeriodFor(
				'2026-03-20',
				config({ type: 'semimonthly', anchor: '2026-01-28' }),
			),
		).toMatchObject({ start: '2026-03-16', end: '2026-03-31' })
	})

	it('rejects unknown types, bad dates and extra keys in settings', () => {
		expect(
			payPeriodSettingsSchema.safeParse({
				payPeriod: 'weekly',
				payPeriodAnchor: null,
			}).success,
		).toBe(true)
		for (const bad of [
			{ payPeriod: 'daily', payPeriodAnchor: null },
			{ payPeriod: 'weekly', payPeriodAnchor: '2026-02-30' },
			{ payPeriod: 'weekly', payPeriodAnchor: null, extra: 1 },
			{ payPeriod: 'weekly' },
		]) {
			expect(payPeriodSettingsSchema.safeParse(bad).success).toBe(false)
		}
	})
})
