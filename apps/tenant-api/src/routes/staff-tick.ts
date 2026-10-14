import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN, listTenantOrgIds } from '@repo/tenant-db'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { fanOutStaffTick } from '../services/staff-tick-fanout.ts'
import { runStaffTickForOrg } from '../services/staff-tick-service.ts'

/**
 * `POST /api/staff/tick`: the regional tick, driven by the existing hourly cron
 * fan-out (no cron slot of its own). Authenticated with `INTERNAL_COMMAND_TOKEN`
 * only; an operator token never works here.
 *
 * With an `orgId` it runs that organization. Without one it runs every
 * organization on this node, which is what the cron does on the Node runtime;
 * on the Workers runtime the edge handler does the fan-out and forwards each
 * organization to its Durable Object, which lands here with an `orgId`.
 *
 * Responses carry counts and short codes only: no name, time or pay, and no
 * list of people.
 */
export const staffTickRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

staffTickRoutes.use(
	'*',
	rateLimit('staff-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
)

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'Staff tick is not configured' }, 503, NO_STORE)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401, NO_STORE)
	}
	return null
}

const tickBodySchema = z
	.object({
		orgId: z
			.string()
			.regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format')
			.optional(),
	})
	.strict()

staffTickRoutes.post('/tick', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = tickBodySchema.safeParse(body ?? {})
	if (!parsed.success) {
		return c.json({ error: 'Invalid payload' }, 400, NO_STORE)
	}

	if (parsed.data.orgId) {
		const result = await runStaffTickForOrg(parsed.data.orgId)
		return c.json({ success: true, result }, 200, NO_STORE)
	}

	const orgIds = await listTenantOrgIds()
	const totals = await fanOutStaffTick({
		orgIds,
		run: (orgId) => runStaffTickForOrg(orgId).catch(() => null),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
