import { internalContextChangedSchema } from '@repo/reservations'
import { getTenantDb, rsvGuests, TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { json, readJsonBody } from '../lib/http.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getReservationsContext,
	invalidateReservationsContext,
} from '../lib/reservations-context.ts'
import {
	invalidateReservationDayCache,
	sweepExpiredInTx,
} from '../lib/reservations-write.ts'
import {
	bearerMatches,
	getInternalCommandToken,
	getVoiceAgentToken,
	voiceAgentTokenProblem,
} from '../lib/secrets.ts'

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
	const org = await findActiveOrganizationById(orgId)
	if (!org) {
		return json({ error: 'not_found', message: 'Organization not found' }, 404)
	}
	if (!orgMatchesNodeRegion(org.dataRegion)) {
		return json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${org.dataRegion}" does not match node "${getNodeRegion()}"`,
			},
			403,
		)
	}
	return null
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

const tickBodySchema = z.strictObject({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN).optional(),
	nowMs: z.number().int().positive().optional(),
})

export const reservationsTickRoutes = new Hono()

reservationsTickRoutes.post('/tick', async (c) => {
	const authErr = requireInternalAuth(c.req.header('Authorization'))
	if (authErr) return authErr

	const parsed = await readJsonBody(c, tickBodySchema)
	if ('error' in parsed) return parsed.error

	const now = parsed.data.nowMs ?? Date.now()
	if (!parsed.data.orgId) {
		return json({
			ok: true,
			orgId: null,
			swept: {
				expiredHolds: 0,
				expiredPendingPayments: 0,
				expiredPendingRequests: 0,
				expiredWaitlistOffers: 0,
			},
		})
	}

	const orgErr = await verifyOrgAndRegion(parsed.data.orgId)
	if (orgErr) return orgErr

	const db = await getTenantDb(parsed.data.orgId)
	const swept = await sweepExpiredInTx(db, { now })

	return json({
		ok: true,
		orgId: parsed.data.orgId,
		swept: {
			expiredHolds: swept.expiredHolds,
			expiredPendingPayments: swept.expiredPendingPayments,
			expiredPendingRequests: swept.expiredPendingRequests,
			expiredWaitlistOffers: swept.expiredWaitlistOffers,
		},
	})
})

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
