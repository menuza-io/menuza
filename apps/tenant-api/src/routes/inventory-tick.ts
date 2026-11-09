import {
	INVENTORY_TICK_PATH,
	inventoryTickRequestSchema,
} from '@repo/inventory'
import { listTenantOrgIds, TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	fanOutInventoryTick,
	runInventoryTickForOrg,
	runInventoryTickLogged,
} from '../services/inventory-tick-service.ts'

/**
 * `POST /api/inventory/tick` (`INVENTORY_TICK_PATH`): the regional inventory
 * tick, driven by the hourly cron fan-out, the Durable Object alarm and the
 * Node interval. Authenticated with `INTERNAL_COMMAND_TOKEN` only. With an
 * `orgId` it runs that organization; without one every organization on this
 * node (on the Workers runtime the edge fans out instead). Idempotent;
 * responses carry counts only (`inventoryTickAnswerSchema`).
 */
export const inventoryTickRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

inventoryTickRoutes.use(
	'*',
	rateLimit('inventory-tick', { windowMs: 60 * 1000, maxRequests: 60 }),
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

// The mount point is `/api/inventory`; the contract's path ends in `/tick`.
const TICK_ROUTE = INVENTORY_TICK_PATH.replace('/api/inventory', '')

inventoryTickRoutes.post(TICK_ROUTE, async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	const body = await c.req.json().catch(() => ({}))
	const parsed = inventoryTickRequestSchema.safeParse(body ?? {})
	if (
		!parsed.success ||
		(parsed.data.orgId && !TENANT_ORG_ID_PATTERN.test(parsed.data.orgId))
	) {
		return c.json({ error: 'validation_error' }, 400, NO_STORE)
	}
	if (parsed.data.orgId) {
		const result = await runInventoryTickForOrg(parsed.data.orgId)
		return c.json({ success: result.errors === 0, result }, 200, NO_STORE)
	}
	const totals = await fanOutInventoryTick({
		orgIds: await listTenantOrgIds(),
		run: (orgId) => runInventoryTickLogged(orgId),
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
