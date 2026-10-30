import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import {
	syncEmailEngagementForAllOrgs,
	syncEmailEngagementForOrg,
} from '../services/email-engagement-sync.ts'

export const engagementSyncRoutes = new Hono()

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'Engagement sync is not configured' }, 503)
	}

	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

	return null
}

const syncBodySchema = z.object({
	orgId: z
		.string()
		.regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format')
		.optional(),
	lookbackHours: z
		.number()
		.int()
		.min(1)
		.max(24 * 14)
		.optional(),
})

engagementSyncRoutes.post('/sync-engagement', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied

	const body = await c.req.json().catch(() => ({}))
	const parsed = syncBodySchema.safeParse(body)
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
			400,
		)
	}

	const lookbackHours = parsed.data.lookbackHours
	if (parsed.data.orgId) {
		const result = await syncEmailEngagementForOrg(parsed.data.orgId, {
			lookbackHours,
			force: true,
		})
		return c.json({ success: true, ...result })
	}

	const result = await syncEmailEngagementForAllOrgs({ lookbackHours })
	return c.json({ success: true, ...result })
})
