/**
 * Location scorecard rankings (#370). Pure, tested ranking for one metric set.
 */

export const SCORECARD_MIN_ORDERS = 10

export type LocationMetricRow = {
	locationId: string
	salesMinor: number
	orderCount: number
	cancelledCount: number
	missedCount: number
	ratingSum: number
	ratingCount: number
}

export type LocationScorecardEntry = {
	locationId: string
	salesMinor: number
	cancellationRate: number | null
	missedRate: number | null
	avgRating: number | null
	enoughData: boolean
}

function rate(numerator: number, denominator: number): number | null {
	if (denominator < SCORECARD_MIN_ORDERS) return null
	return denominator > 0 ? numerator / denominator : 0
}

export function buildLocationScorecard(
	rows: readonly LocationMetricRow[],
): LocationScorecardEntry[] {
	return rows.map((row) => {
		const orders = row.orderCount
		const enoughData = orders >= SCORECARD_MIN_ORDERS
		return {
			locationId: row.locationId,
			salesMinor: row.salesMinor,
			cancellationRate: rate(row.cancelledCount, orders),
			missedRate: rate(row.missedCount, orders),
			avgRating:
				row.ratingCount >= SCORECARD_MIN_ORDERS
					? row.ratingSum / row.ratingCount
					: null,
			enoughData,
		}
	})
}

export function rankLocations<T extends { locationId: string }>(
	entries: readonly T[],
	compare: (a: T, b: T) => number,
): T[] {
	return [...entries].sort(compare)
}
