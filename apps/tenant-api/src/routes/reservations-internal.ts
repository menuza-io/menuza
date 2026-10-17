import { internalContextChangedSchema } from '@repo/reservations'
import { getTenantDb, rsvGuests, TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { json, readJsonBody } from '../lib/http.ts'
import {
	getReservationsContext,
	invalidateReservationsContext,
} from '../lib/reservations-context.ts'
import { ensureActiveOrgInNodeRegion } from '../lib/reservations-guard.ts'
import { invalidateReservationDayCache } from '../lib/reservations-write.ts'
import {
	bearerMatches,
	getInternalCommandToken,
	getVoiceAgentToken,
	voiceAgentTokenProblem,
} from '../lib/secrets.ts'
import { getRegionalReservationSummary } from '../services/rsv-day-feed-service.js'

function requireInternalAuth(authHeader: string | undefined): Response | null {
	const token = getInternalCommandToken()
	if (token.length < 16) {
		return json({ error: 'service_unavailable' }, 503)
	}
	if (!bearerMatches(authHeader, token, 16)) {
		return json({ error: 'unauthorized' }, 401)
	}
	return null
}

function requireVoiceAuth(authHeader: string | undefined): Response | null {
	const problem = voiceAgentTokenProblem()
	if (problem) {
		return json({ error: 'service_unavailable' }, 503)
	}
	if (!bearerMatches(authHeader, getVoiceAgentToken(), 32)) {
		return json({ error: 'unauthorized' }, 401)
	}
	return null
}

async function verifyOrgAndRegion(orgId: string): Promise<Response | null> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) {
		return json({ error: 'validation_error', message: 'Invalid orgId' }, 400)
	}
	return ensureActiveOrgInNodeRegion({ orgId })
}

export const reservationsInternalRoutes = new Hono()

reservationsInternalRoutes.post('/context-changed', async (c) => {
	const authErr = requireInternalAuth(c.req.header('Authorization'))
	if (authErr) return authErr

	const parsed = await readJsonBody(c, internalContextChangedSchema)
	if ('error' in parsed) return parsed.error

	const orgErr = await verifyOrgAndRegion(parsed.data.orgId)
	if (orgErr) return orgErr

	invalidateReservationsContext(parsed.data.orgId)
	invalidateReservationDayCache(parsed.data.orgId)

	return json({ ok: true, orgId: parsed.data.orgId })
})

const eraseCustomerSchema = z.strictObject({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	customerId: z.string().trim().min(1).max(128),
})

reservationsInternalRoutes.post('/erase-customer', async (c) => {
	const authErr = requireInternalAuth(c.req.header('Authorization'))
	if (authErr) return authErr

	const parsed = await readJsonBody(c, eraseCustomerSchema)
	if ('error' in parsed) return parsed.error

	const orgErr = await verifyOrgAndRegion(parsed.data.orgId)
	if (orgErr) return orgErr

	const db = await getTenantDb(parsed.data.orgId)
	const now = Date.now()
	await db
		.update(rsvGuests)
		.set({
			firstName: 'Deleted',
			lastName: 'Guest',
			phoneE164: null,
			emailNorm: null,
			allergyNotes: null,
			erasedAt: now,
			updatedAt: now,
		})
		.where(eq(rsvGuests.customerId, parsed.data.customerId))

	return json({ ok: true, orgId: parsed.data.orgId })
})

const internalSummarySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	locationId: z.string().trim().min(1).max(128).optional().nullable(),
	locationIds: z.array(z.string().trim().min(1).max(128)).optional().nullable(),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.nullable(),
})

async function handleInternalSummary(c: any) {
	const authErr = requireInternalAuth(c.req.header('Authorization'))
	if (authErr) return authErr

	const parsed = await readJsonBody(c, internalSummarySchema)
	if ('error' in parsed) return parsed.error

	const orgErr = await verifyOrgAndRegion(parsed.data.orgId)
	if (orgErr) return orgErr

	const db = await getTenantDb(parsed.data.orgId)
	const summary = await getRegionalReservationSummary(db, {
		locationId: parsed.data.locationId ?? null,
		locationIds: parsed.data.locationIds ?? null,
		date: parsed.data.date ?? null,
	})
	const locationId =
		parsed.data.locationId ?? parsed.data.locationIds?.[0] ?? undefined
	const region = (process.env.DATA_REGION ?? 'us') as 'us' | 'ksa'

	return json({
		ok: true,
		orgId: parsed.data.orgId,
		region,
		...(locationId ? { locationId } : {}),
		...summary,
		summary: {
			...(locationId ? { locationId } : {}),
			...summary,
		},
	})
}

reservationsInternalRoutes.post('/summary', handleInternalSummary)
reservationsInternalRoutes.post('/location-summary', handleInternalSummary)

export { reservationsTickRoutes } from './reservations-tick.ts'

const voiceAvailabilitySchema = z.strictObject({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	locationId: z.string().trim().min(1).max(128),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	partySize: z.number().int().min(1).max(99).optional(),
})

export const reservationsVoiceActionRoutes = new Hono()

reservationsVoiceActionRoutes.post('/reservation-availability', async (c) => {
	const authErr = requireVoiceAuth(c.req.header('Authorization'))
	if (authErr) return authErr

	const parsed = await readJsonBody(c, voiceAvailabilitySchema)
	if ('error' in parsed) return parsed.error

	const orgErr = await verifyOrgAndRegion(parsed.data.orgId)
	if (orgErr) return orgErr

	const ctx = await getReservationsContext(parsed.data.orgId)
	if (ctx && (!ctx.features.enabled || !ctx.features.voice)) {
		return json({ error: 'feature_disabled' }, 404)
	}

	return json({
		ok: true,
		orgId: parsed.data.orgId,
		locationId: parsed.data.locationId,
		slots: [],
	})
})
