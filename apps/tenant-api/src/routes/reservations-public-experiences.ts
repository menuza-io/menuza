import { getTenantDb } from '@repo/tenant-db'
import { type Context, type Hono } from 'hono'
import {
	notFoundResponse,
	type ResolvedPublicOrg,
} from '../lib/reservations-public-auth.ts'
import {
	getPublicExperience,
	listPublicExperiences,
} from '../services/rsv-experience-public.ts'

const MINUTE = 60_000

type Limit = { name: string; max: number; windowMs: number }

/** The shared building blocks of the public router, handed in so this file never imports it back. */
export type PublicExperienceRouteKit = {
	gate: (
		c: Context,
		scope: 'booking' | 'manage',
		limit?: Limit,
	) => Promise<
		{ ok: true; value: ResolvedPublicOrg } | { ok: false; response: Response }
	>
	guarded: (
		handler: (c: Context) => Promise<Response>,
	) => (c: Context) => Promise<Response>
	readLocale: (c: Context) => string | null
}

const SLUG_RE = /^[a-z0-9-]{1,64}$/

/**
 * Catalog data only, safe to cache for a minute. The answer depends on the
 * Origin (which organization) and the requested language.
 */
const PUBLIC_CATALOG_HEADERS = {
	'Cache-Control': 'public, max-age=60',
	Vary: 'Origin, Accept-Language',
}

/**
 * `GET /reservations/experiences` and `/experiences/:slug`: published
 * experiences of bookable locations. They need `reservations.online` (the
 * `booking` gate) and `reservations.experiences`; anything else, including an
 * unknown or wrong-region Origin, answers the same uniform 404.
 */
export function registerPublicExperienceRoutes(
	router: Hono,
	kit: PublicExperienceRouteKit,
) {
	const { gate, guarded, readLocale } = kit

	router.get(
		'/experiences',
		guarded(async (c) => {
			const g = await gate(c, 'booking', {
				name: 'experiences',
				max: 120,
				windowMs: MINUTE,
			})
			if (!g.ok) return g.response
			if (!g.value.context.features.experiences) return notFoundResponse()
			const db = await getTenantDb(g.value.org.id)
			const now = Date.now()
			const experiences = await listPublicExperiences(db, g.value.context, {
				locale: readLocale(c),
				now,
			})
			return Response.json(
				{ now: new Date(now).toISOString(), experiences },
				{ status: 200, headers: PUBLIC_CATALOG_HEADERS },
			)
		}),
	)

	router.get(
		'/experiences/:slug',
		guarded(async (c) => {
			const g = await gate(c, 'booking', {
				name: 'experiences',
				max: 120,
				windowMs: MINUTE,
			})
			if (!g.ok) return g.response
			if (!g.value.context.features.experiences) return notFoundResponse()
			const slug = c.req.param('slug') ?? ''
			if (!SLUG_RE.test(slug)) return notFoundResponse()
			const db = await getTenantDb(g.value.org.id)
			const now = Date.now()
			const experience = await getPublicExperience(db, g.value.context, {
				slug,
				locationId: c.req.query('locationId')?.trim() || null,
				locale: readLocale(c),
				now,
			})
			return Response.json(
				{ now: new Date(now).toISOString(), experience },
				{ status: 200, headers: PUBLIC_CATALOG_HEADERS },
			)
		}),
	)
}
