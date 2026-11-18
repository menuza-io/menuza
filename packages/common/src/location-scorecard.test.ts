import { describe, expect, it } from 'vitest'
import {
	buildLocationScorecard,
	rankLocations,
	SCORECARD_MIN_ORDERS,
} from './location-scorecard.ts'

describe('location scorecard', () => {
	it('ranks by sales correctly', () => {
		const rows = buildLocationScorecard([
			{
				locationId: 'a',
				salesMinor: 100,
				orderCount: SCORECARD_MIN_ORDERS,
				cancelledCount: 1,
				missedCount: 0,
				ratingSum: 40,
				ratingCount: 10,
			},
			{
				locationId: 'b',
				salesMinor: 200,
				orderCount: SCORECARD_MIN_ORDERS,
				cancelledCount: 0,
				missedCount: 0,
				ratingSum: 45,
				ratingCount: 10,
			},
		])
		const ranked = rankLocations(rows, (a, b) => b.salesMinor - a.salesMinor)
		expect(ranked[0]!.locationId).toBe('b')
		expect(ranked[1]!.locationId).toBe('a')
	})

	it('marks not enough data below threshold', () => {
		const [row] = buildLocationScorecard([
			{
				locationId: 'x',
				salesMinor: 0,
				orderCount: 2,
				cancelledCount: 0,
				missedCount: 0,
				ratingSum: 0,
				ratingCount: 0,
			},
		])
		expect(row!.enoughData).toBe(false)
		expect(row!.cancellationRate).toBeNull()
	})
})
