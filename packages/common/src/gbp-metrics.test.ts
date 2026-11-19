import { describe, expect, it } from 'vitest'
import {
	backfillStart,
	comparePeriods,
	formatKeywordValue,
	lastSearchMonth,
	percentChange,
	pivotDailyFigures,
} from './gbp-metrics.ts'

const days = (from: string, count: number, metric: string, value: number) =>
	Array.from({ length: count }, (_, index) => {
		const date = new Date(`${from}T00:00:00Z`)
		date.setUTCDate(date.getUTCDate() + index)
		return { date: date.toISOString().slice(0, 10), metric, value }
	})

describe('comparePeriods', () => {
	it('compares the last 28 days with the 28 before, ending at the newest data', () => {
		const rows = [
			...days('2026-09-15', 28, 'CALL_CLICKS', 1),
			...days('2026-10-13', 28, 'CALL_CLICKS', 2),
			...days('2026-10-13', 28, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 10),
		]
		const result = comparePeriods(rows)
		expect(result.dataUntil).toBe('2026-11-09')
		expect(result.current.calls).toBe(56)
		expect(result.previous.calls).toBe(28)
		expect(result.current.mapsViews).toBe(280)
		expect(result.trend).toHaveLength(28)
		expect(percentChange(result.current.calls, result.previous.calls)).toBe(100)
	})
	it('has no data until something is stored', () => {
		expect(comparePeriods([]).dataUntil).toBeNull()
		expect(percentChange(5, 0)).toBeNull()
	})
	it('pivots daily metrics into figures', () => {
		const rows = pivotDailyFigures([
			{
				date: '2026-11-01',
				metric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
				value: 3,
			},
			{
				date: '2026-11-01',
				metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
				value: 4,
			},
			{ date: '2026-11-01', metric: 'WEBSITE_CLICKS', value: 2 },
		])
		expect(rows).toEqual([
			expect.objectContaining({
				date: '2026-11-01',
				searchViews: 7,
				websiteClicks: 2,
			}),
		])
	})
	it('knows the 18 month backfill start, the last search month and ranges', () => {
		expect(backfillStart(new Date('2026-11-19T10:00:00Z'))).toBe('2025-05-19')
		expect(lastSearchMonth(new Date('2026-11-19T10:00:00Z'))).toBe('2026-10')
		expect(formatKeywordValue({ value: null, threshold: 15 })).toBe('< 15')
		expect(formatKeywordValue({ value: 42, threshold: null })).toBe('42')
	})
})
