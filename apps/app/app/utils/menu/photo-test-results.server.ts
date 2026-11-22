import { type PhotoTestResultsResponse } from '@repo/common/photo-test-results'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { type PhotoTestCounts } from './photo-tests.server.ts'

/**
 * Reads the regional counters of photo tests (#192) with a short-lived server
 * token of the `photo_tests` scope. The caller has already checked that the
 * member may read the menu. Numbers only come back. A region that cannot be
 * reached yields `null`, so the page shows the test without numbers instead of
 * failing.
 */
export function photoTestCountsReader(request: Request, orgSlug: string) {
	return async (
		tests: Array<{
			testId: string
			itemId: string
			startedAt: number
			endedAt: number | null
		}>,
	): Promise<Map<string, PhotoTestCounts> | null> => {
		if (tests.length === 0) return new Map()
		try {
			const client = await getOperatorTenantClient(request, orgSlug, {
				scope: 'photo_tests',
				expiresIn: '5m',
			})
			const response = await client.fetchTenant(
				'/operator/photo-tests/results',
				{ method: 'POST', body: JSON.stringify({ tests: tests.slice(0, 20) }) },
			)
			if (!response.ok) return null
			const body = (await response.json()) as PhotoTestResultsResponse
			return new Map(
				body.results.map((result) => [
					result.testId,
					{ A: result.A, B: result.B },
				]),
			)
		} catch (error) {
			console.error('photo tests: could not read the regional counters', {
				error: error instanceof Error ? error.message : 'unknown',
			})
			return null
		}
	}
}
