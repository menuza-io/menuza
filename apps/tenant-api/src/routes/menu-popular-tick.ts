import { listTenantOrgIds, TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	fanOutMenuPopularTick,
	runMenuPopularTickForOrg,
	runMenuPopularTickLogged,
} from '../services/popular-items-service.ts'

/**
 * `POST /api/menu/popular/tick`: daily-per-org Auto Popular tick, driven by
 * the hourly cron fan-out. Authenticated with `INTERNAL_COMMAND_TOKEN` only.
 */
export const menuPopularTickRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const tickRequestSchema = z
	.object({
		orgId: z.string().trim().min(1).max(128).optional(),
		force: z.boolean().optional(),
	})
	.strict()

menuPopularTickRoutes.use(
	'*',
	rateLimit('menu-popular-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
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

menuPopularTickRoutes.post('/tick', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = tickRequestSchema.safeParse(body ?? {})
	if (
		!parsed.success ||
		(parsed.data.orgId && !TENANT_ORG_ID_PATTERN.test(parsed.data.orgId))
	) {
		return c.json({ error: 'validation_error' }, 400, NO_STORE)
	}

	if (parsed.data.orgId) {
		const result = await runMenuPopularTickForOrg(parsed.data.orgId, {
			force: parsed.data.force,
		})
		return c.json({ success: result.errors === 0, result }, 200, NO_STORE)
	}

	const totals = await fanOutMenuPopularTick({
		orgIds: await listTenantOrgIds(),
		run: (orgId) => runMenuPopularTickLogged(orgId),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
