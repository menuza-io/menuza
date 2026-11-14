import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN, listTenantOrgIds } from '@repo/tenant-db'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	fanOutOrderMessagesTick,
	runOrderMessagesTickForOrg,
	runOrderMessagesTickLogged,
} from '../services/order-message-send.ts'

/**
 * `POST /api/order-messages/tick`: sends guest order messages that are due
 * (retries of a failed receipt or status message), driven by the hourly cron
 * fan-out, the Durable Object alarm and the Node interval. Authenticated with
 * `INTERNAL_COMMAND_TOKEN` only. With an `orgId` it runs that organization;
 * without one every organization on this node (on the Workers runtime the edge
 * fans out instead). Idempotent; responses carry counts only.
 */
export const orderMessagesTickRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

orderMessagesTickRoutes.use(
	'*',
	rateLimit('order-messages-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
)

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'service_unavailable' }, 503, NO_STORE)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'unauthorized' }, 401, NO_STORE)
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

orderMessagesTickRoutes.post('/tick', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	const body = await c.req.json().catch(() => ({}))
	const parsed = tickBodySchema.safeParse(body ?? {})
	if (!parsed.success) {
		return c.json({ error: 'validation_error' }, 400, NO_STORE)
	}
	if (parsed.data.orgId) {
		const result = await runOrderMessagesTickForOrg(parsed.data.orgId)
		return c.json({ success: true, result }, 200, NO_STORE)
	}
	const totals = await fanOutOrderMessagesTick({
		orgIds: await listTenantOrgIds(),
		run: (orgId) => runOrderMessagesTickLogged(orgId),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
