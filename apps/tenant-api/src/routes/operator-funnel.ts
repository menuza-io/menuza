import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	funnelQuerySchema,
	readExperimentCounts,
	readFunnel,
} from '../services/site-events.ts'
import { authenticateOperator } from './operator.ts'

/**
 * `/operator/funnel` (#179, #338): the website funnel and the counts of a test,
 * read by the browser with a `funnel`-scope operator token (the App mints it
 * for `read:website:any`). Counts only; no row names a person. Every response
 * is `private, no-store`.
 */
export const funnelOperatorRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

funnelOperatorRoutes.get('/', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c, 'funnel')).orgId
	} catch (response) {
		return response as Response
	}
	const parsed = funnelQuerySchema.safeParse(c.req.query())
	if (!parsed.success)
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	const db = await getTenantDb(orgId)
	return c.json(await readFunnel(db, parsed.data), 200, NO_STORE)
})

funnelOperatorRoutes.get('/experiments/:experimentId', async (c) => {
	let orgId: string
	try {
		orgId = (await authenticateOperator(c, 'funnel')).orgId
	} catch (response) {
		return response as Response
	}
	const id = c.req.param('experimentId')
	const from = c.req.query('from') ?? ''
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	}
	const db = await getTenantDb(orgId)
	return c.json(await readExperimentCounts(db, id, from), 200, NO_STORE)
})
