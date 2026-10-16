import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb, rsvGuests } from '@repo/tenant-db'
import { desc } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json } from '../lib/http.ts'
import {
	hasReservationsGrant,
	requireReservationsLocation,
} from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import {
	createGuestProfile,
	eraseGuestProfile,
	exportGuestProfile,
	getGuestSummary,
	searchGuests,
} from '../services/rsv-guest-service.js'

async function parseBody<T extends z.ZodTypeAny>(
	c: Context,
	schema: T,
): Promise<{ data: z.infer<T> } | { error: Response }> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return {
			error: json(
				{ error: 'invalid_json', message: 'Request body must be valid JSON' },
				400,
			),
		}
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		return {
			error: json(
				{
					error: 'validation_error',
					issues: parsed.error.issues.map((issue) => ({
						path: issue.path.join('.'),
						code: issue.code,
						message: issue.message,
					})),
				},
				400,
			),
		}
	}
	return { data: parsed.data }
}

function parseQuery<T extends z.ZodTypeAny>(
	c: Context,
	schema: T,
): { data: z.infer<T> } | { error: Response } {
	const raw: Record<string, string> = {}
	const url = new URL(c.req.url)
	for (const [k, v] of url.searchParams.entries()) {
		raw[k] = v
	}
	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		return {
			error: json(
				{
					error: 'validation_error',
					issues: parsed.error.issues.map((issue) => ({
						path: issue.path.join('.'),
						code: issue.code,
						message: issue.message,
					})),
				},
				400,
			),
		}
	}
	return { data: parsed.data }
}

export const operatorReservationsGuestsRoutes = new Hono()

const listGuestsQuerySchema = z.object({
	q: z.string().trim().max(120).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
})

operatorReservationsGuestsRoutes.get(
	'/',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, listGuestsQuerySchema)
		if ('error' in q) return q.error

		try {
			const db = await getTenantDb(ctx.orgId)
			if (q.data.q && q.data.q.length > 0) {
				const guests = await searchGuests(db, q.data.q, q.data.limit)
				return json({ ok: true, orgId: ctx.orgId, guests })
			}
			const guests = await db
				.select()
				.from(rsvGuests)
				.orderBy(desc(rsvGuests.updatedAt))
				.limit(q.data.limit)
				.all()
			return json({ ok: true, orgId: ctx.orgId, guests })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.get(
	'/lookup',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, listGuestsQuerySchema)
		if ('error' in q) return q.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const guests = await searchGuests(db, q.data.q ?? '', q.data.limit)
			return json({ ok: true, orgId: ctx.orgId, guests })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const createGuestBodySchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	firstName: z.string().trim().min(1).max(120),
	lastName: z.string().trim().max(120).optional().default(''),
	phone: z.string().trim().max(32).optional().nullable(),
	phoneE164: z.string().trim().max(32).optional().nullable(),
	email: z.string().trim().email().max(255).optional().nullable(),
	emailNorm: z.string().trim().email().max(255).optional().nullable(),
	locale: z.string().trim().max(16).optional(),
	smsOptIn: z.boolean().optional(),
	allergyNotes: z.string().max(1000).optional().nullable(),
	tagIds: z.array(z.string().trim().min(1)).optional(),
	note: z.string().max(2000).optional().nullable(),
})

operatorReservationsGuestsRoutes.post(
	'/',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, createGuestBodySchema)
		if ('error' in parsed) return parsed.error

		if (parsed.data.locationId) {
			const locCheck = requireReservationsLocation(ctx, parsed.data.locationId)
			if (!locCheck.ok) return locCheck.response
		}

		try {
			const db = await getTenantDb(ctx.orgId)
			const guest = await createGuestProfile(db, {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, guest }, 201)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.get(
	'/:id',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		try {
			const db = await getTenantDb(ctx.orgId)
			const summary = await getGuestSummary(db, c.req.param('id'), {
				canReadSensitive: true,
			})
			return json({ ok: true, orgId: ctx.orgId, ...summary })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.get(
	'/:id/summary',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		try {
			const db = await getTenantDb(ctx.orgId)
			const summary = await getGuestSummary(db, c.req.param('id'), {
				canReadSensitive: true,
			})
			return json({ ok: true, orgId: ctx.orgId, ...summary })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const exportGuestQuerySchema = z.object({
	includeSensitive: z.string().optional(),
})

operatorReservationsGuestsRoutes.get(
	'/:id/export',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, exportGuestQuerySchema)
		if ('error' in q) return q.error

		const rawSensitive = q.data.includeSensitive?.trim().toLowerCase()
		const includeSensitive =
			rawSensitive === '1' || rawSensitive === 'true' || rawSensitive === 'yes'

		if (
			includeSensitive &&
			!hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
			)
		) {
			return json(
				{
					error: 'missing_grant',
					message: 'Sensitive export requires update:reservation_guest:any',
				},
				403,
			)
		}

		try {
			const db = await getTenantDb(ctx.orgId)
			const exported = await exportGuestProfile(db, {
				guestId: c.req.param('id'),
				actorId: ctx.userId,
				includeSensitive,
			})
			return json({ ok: true, orgId: ctx.orgId, ...exported })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const eraseGuestBodySchema = z
	.object({
		locationId: z.string().trim().min(1).max(128).optional(),
	})
	.passthrough()

operatorReservationsGuestsRoutes.post(
	'/:id/erase',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, eraseGuestBodySchema)
		if ('error' in parsed) return parsed.error

		if (parsed.data.locationId) {
			const locCheck = requireReservationsLocation(ctx, parsed.data.locationId)
			if (!locCheck.ok) return locCheck.response
		}

		try {
			const db = await getTenantDb(ctx.orgId)
			const erased = await eraseGuestProfile(db, c.req.param('id'), {
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, ...erased })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)
