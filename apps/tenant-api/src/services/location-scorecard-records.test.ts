import { describe, expect, it } from 'vitest'
import { buildLocationScorecard } from '@repo/common/location-scorecard'
import { loadLocationScorecardRows } from './location-scorecard-records.ts'

describe('location scorecard records', () => {
	it('ranks locations by sales in pure scorecard math', () => {
		const rows = buildLocationScorecard([
			{
				locationId: 'loc_a',
				salesMinor: 100_00,
				orderCount: 20,
				cancelledCount: 2,
				missedCount: 1,
				ratingSum: 0,
				ratingCount: 0,
			},
			{
				locationId: 'loc_b',
				salesMinor: 50_00,
				orderCount: 5,
				cancelledCount: 0,
				missedCount: 0,
				ratingSum: 0,
				ratingCount: 0,
			},
		])
		expect(rows.find((r) => r.locationId === 'loc_a')?.enoughData).toBe(true)
		expect(rows.find((r) => r.locationId === 'loc_b')?.enoughData).toBe(false)
	})

	it('exports loadLocationScorecardRows', () => {
		expect(typeof loadLocationScorecardRows).toBe('function')
	})
})
