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
	fanOutGiftCardTick,
	runGiftCardTickForOrg,
	runGiftCardTickLogged,
} from '../services/gift-card-tick-service.ts'

/**
 * `POST /api/gift-cards/tick`: the regional gift-card tick (timed holds,
 * lapsed purchases, due emails), driven by the hourly cron fan-out, the
 * Durable Object alarm and the Node interval. Authenticated with
 * `INTERNAL_COMMAND_TOKEN` only. With an `orgId` it runs that organization;
 * without one every organization on this node. Responses carry counts only.
 */
export const giftCardTickRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

giftCardTickRoutes.use(
	'*',
	rateLimit('gift-cards-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
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

giftCardTickRoutes.post('/tick', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	const body = await c.req.json().catch(() => ({}))
	const parsed = tickBodySchema.safeParse(body ?? {})
	if (!parsed.success) {
		return c.json({ error: 'validation_error' }, 400, NO_STORE)
	}
	if (parsed.data.orgId) {
		const result = await runGiftCardTickForOrg(parsed.data.orgId)
		return c.json({ success: true, result }, 200, NO_STORE)
	}
	const totals = await fanOutGiftCardTick({
		orgIds: await listTenantOrgIds(),
		run: (orgId) => runGiftCardTickLogged(orgId),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
