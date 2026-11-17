import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { menuAvailabilityEvents } from '@repo/tenant-db'
import { getTenantDb } from '@repo/tenant-db'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'

export const menuAvailabilityEventRoutes = new Hono()

function checkSystemAuth(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'System API is not configured' }, 503)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

const bodySchema = z.object({
	orgId: z.string().min(1).max(64),
	locationId: z.string().min(1).max(64),
	entityType: z.enum(['item', 'modifier_option']),
	entityId: z.string().min(1).max(64),
	event: z.enum(['unavailable', 'available']),
})

menuAvailabilityEventRoutes.post('/availability-events', async (c) => {
	const denied = checkSystemAuth(c)
	if (denied) return denied
	const parsed = bodySchema.safeParse(await c.req.json())
	if (!parsed.success) {
		return c.json({ error: 'invalid_body' }, 422)
	}
	const db = await getTenantDb(parsed.data.orgId)
	await db.insert(menuAvailabilityEvents).values({
		locationId: parsed.data.locationId,
		entityType: parsed.data.entityType,
		entityId: parsed.data.entityId,
		event: parsed.data.event,
		occurredAt: new Date(),
	})
	return c.json({ ok: true })
})
