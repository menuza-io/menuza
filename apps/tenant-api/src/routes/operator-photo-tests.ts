import { photoTestResultsRequestSchema } from '@repo/common/photo-test-results'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { readPhotoTestResults } from '../services/dish-photo-tests.ts'
import { authenticateOperator } from './operator.ts'

/**
 * `/operator/photo-tests` (#192): the counters of dish photo tests, asked for
 * by the App's server with a `photo_tests`-scope operator token (minted after
 * the `read:menu:any` check). Counts only; no row names a person. Every
 * response is `private, no-store`.
 */
export const photoTestOperatorRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

photoTestOperatorRoutes.post('/results', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c, 'photo_tests')).orgId
	} catch (response) {
		return response as Response
	}
	const parsed = photoTestResultsRequestSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) {
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	}
	const db = await getTenantDb(orgId)
	return c.json(
		{ results: await readPhotoTestResults(db, parsed.data.tests) },
		200,
		NO_STORE,
	)
})
