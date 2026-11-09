import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN, listTenantOrgIds } from '@repo/tenant-db'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { startBroadcastTickForOrg } from '../services/broadcast-dispatch.ts'
import { pruneSmsSendEventsForOrg } from '../services/sms-send-limits.ts'
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

/**
 * Lets a claimed broadcast keep sending after the response: `waitUntil` at the
 * edge; elsewhere (Node, or the Durable Object, where Hono has no execution
 * context) the promise simply runs on. The task already catches its errors.
 */
function runDetached(c: Context) {
	return (task: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(task)
		} catch {
			// Hono throws when there is no execution context.
		}
	}
}

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
		// Same pass: claim interrupted broadcasts and scheduled ones that are due,
		// and send them without holding this request.
		await startBroadcastTickForOrg(parsed.data.orgId, {
			runDetached: runDetached(c),
		})
		// Hourly housekeeping (the Workers fan-out lands here per organization;
		// alarms call the services directly). Detached so it never delays the
		// response.
		runDetached(c)(pruneSmsSendEventsForOrg(parsed.data.orgId))
		return c.json({ success: true, result }, 200, NO_STORE)
	}

	const orgIds = await listTenantOrgIds()
	const totals = await fanOutStaffTick({
		orgIds,
		run: async (orgId) => {
			const result = await runStaffTickForOrg(orgId).catch(() => null)
			await startBroadcastTickForOrg(orgId, { runDetached: runDetached(c) })
			// Hourly housekeeping, detached so a slow prune never holds a fan-out
			// slot that a later organization's broadcasts are waiting for.
			runDetached(c)(pruneSmsSendEventsForOrg(orgId))
			return result
		},
	})
	return c.json({ success: totals.errors === 0, ...totals }, 200, NO_STORE)
})
