import { getTenantDb, rsvLocationSettings } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { json, readJsonBody } from '../lib/http.ts'
import {
	type PublishedOrganization,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

function isPublicReservationsDisabled(): boolean {
	syncEnvFromProcess()
	const raw =
		process.env.RESERVATIONS_PUBLIC_ENABLED ??
		(ENV as { RESERVATIONS_PUBLIC_ENABLED?: string })
			.RESERVATIONS_PUBLIC_ENABLED
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}

async function resolvePublicOrg(
	c: Context,
	hint?: { slug?: string; host?: string },
): Promise<
	{ ok: true; org: PublishedOrganization } | { ok: false; response: Response }
> {
	if (isPublicReservationsDisabled()) {
		return {
			ok: false,
			response: json({ error: 'service_unavailable' }, 503),
		}
	}

	const origin = c.req.header('Origin')
	const slug = hint?.slug ?? c.req.query('slug')?.trim()
	const host = hint?.host ?? c.req.query('host')?.trim()

	const org = await resolveOrganizationForBrowserAuth(origin, {
		...(slug ? { slug } : {}),
		...(host ? { host } : {}),
	})
	const provisioned = Boolean(org?.hasProvisionedDb)
	if (!org || !provisioned) {
		return {
			ok: false,
			response: json({ error: 'not_found' }, 404),
		}
	}

	if (!orgMatchesNodeRegion(org.dataRegion)) {
		return {
			ok: false,
			response: json(
				{
					error: 'region_mismatch',
					message: `Organization dataRegion "${org.dataRegion}" does not match node "${getNodeRegion()}"`,
				},
				403,
			),
		}
	}

	const ctx = await getReservationsContext(org.id)
	if (ctx && (!ctx.features.enabled || !ctx.features.online)) {
		return {
			ok: false,
			response: json({ error: 'not_found' }, 404),
		}
	}

	return { ok: true, org }
}

export const reservationsPublicRoutes = new Hono()

reservationsPublicRoutes.get('/config', async (c) => {
	const resolved = await resolvePublicOrg(c)
	if (!resolved.ok) return resolved.response

	const db = await getTenantDb(resolved.org.id)
	const locations = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.onlineEnabled, true))

	return json({
		ok: true,
		orgId: resolved.org.id,
		slug: resolved.org.slug,
		locations: locations.map((loc) => ({
			locationId: loc.locationId,
			timeZone: loc.timeZone,
			minPartySize: loc.onlinePartyMin,
			maxPartySize: loc.onlinePartyMax,
		})),
	})
})

const publicHoldSchema = z.object({
	slug: z.string().trim().min(1).max(120).optional(),
	host: z.string().trim().min(1).max(255).optional(),
	locationId: z.string().trim().min(1).max(128),
	businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	localStartMin: z.number().int().min(0).max(1800),
	partySize: z.number().int().min(1).max(99),
})

reservationsPublicRoutes.post('/holds', async (c) => {
	if (isPublicReservationsDisabled()) {
		return json({ error: 'service_unavailable' }, 503)
	}

	const parsed = await readJsonBody(c, publicHoldSchema)
	if ('error' in parsed) return parsed.error

	const resolved = await resolvePublicOrg(c, {
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if (!resolved.ok) return resolved.response

	return json({
		ok: true,
		orgId: resolved.org.id,
		locationId: parsed.data.locationId,
	})
})
