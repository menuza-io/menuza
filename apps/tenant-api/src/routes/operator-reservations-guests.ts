import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { ECHOING_CODES, handleRouteError, json } from '../lib/http.ts'
import {
	filterReservationsLocations,
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
import {
	addGuestNote,
	assignGuestTag,
	createGuestTag,
	deleteGuestNote,
	getGuestProfile,
	GUEST_SORTS,
	GUEST_TAG_CATEGORIES,
	GUESTBOOK_PAGE_SIZE,
	listGuests,
	listGuestTags,
	mergeGuests,
	removeGuestTag,
	updateGuestNote,
	updateGuestProfile,
	updateGuestTag,
} from '../services/rsv-guestbook-service.ts'

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
						...(ECHOING_CODES.has(issue.code)
							? {}
							: { message: issue.message }),
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
						...(ECHOING_CODES.has(issue.code)
							? {}
							: { message: issue.message }),
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

const pagedGuestsQuerySchema = z.object({
	q: z.string().trim().max(120).optional(),
	tag: z.string().trim().min(1).max(128).optional(),
	sort: z.enum(GUEST_SORTS).optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(GUESTBOOK_PAGE_SIZE),
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

		const q = parseQuery(c, pagedGuestsQuerySchema)
		if ('error' in q) return q.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const page = await listGuests(db, {
				q: q.data.q,
				tagId: q.data.tag,
				sort: q.data.sort,
				cursor: q.data.cursor,
				limit: q.data.limit,
			})
			return json({ ok: true, orgId: ctx.orgId, ...page })
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
			const guests = await searchGuests(db, q.data.q ?? '', {
				limit: q.data.limit,
				canReadSensitive: true,
			})
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
			const guest = await createGuestProfile(
				db,
				{
					...parsed.data,
					actorId: ctx.userId,
				},
				{ canReadSensitive: true },
			)
			return json({ ok: true, orgId: ctx.orgId, guest }, 201)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.get(
	'/tags',
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
			const tags = await listGuestTags(db)
			return json({ ok: true, orgId: ctx.orgId, tags })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const createTagBodySchema = z.object({
	name: z.string().trim().min(1).max(60),
	category: z.enum(GUEST_TAG_CATEGORIES).optional(),
	colorToken: z.string().trim().min(1).max(32).optional(),
})

operatorReservationsGuestsRoutes.post(
	'/tags',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, createTagBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const tag = await createGuestTag(db, {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, tag }, 201)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const updateTagBodySchema = z
	.object({
		name: z.string().trim().min(1).max(60).optional(),
		colorToken: z.string().trim().min(1).max(32).optional(),
		archived: z.boolean().optional(),
	})
	.refine((v) => Object.keys(v).length > 0, { message: 'No changes' })

operatorReservationsGuestsRoutes.patch(
	'/tags/:tagId',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, updateTagBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const tag = await updateGuestTag(db, c.req.param('tagId'), {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, tag })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const mergeBodySchema = z.object({
	keepId: z.string().trim().min(1).max(128),
	mergeId: z.string().trim().min(1).max(128),
	expectedVersions: z.record(z.string(), z.number().int()).optional(),
})

operatorReservationsGuestsRoutes.post(
	'/merge',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, mergeBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const merged = await mergeGuests(db, {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, ...merged })
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
			const profile = await getGuestProfile(db, c.req.param('id'), {
				canReadSensitive: true,
			})
			return json({ ok: true, orgId: ctx.orgId, ...profile })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const updateGuestBodySchema = z
	.object({
		expectedVersion: z.number().int().min(1),
		firstName: z.string().trim().min(1).max(120).optional(),
		lastName: z.string().trim().max(120).optional(),
		phone: z.string().trim().max(32).optional().nullable(),
		email: z.string().trim().email().max(255).optional().nullable(),
		locale: z.string().trim().max(16).optional(),
		allergyNotes: z.string().max(1000).optional().nullable(),
	})
	.strict()

operatorReservationsGuestsRoutes.patch(
	'/:id',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, updateGuestBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const guest = await updateGuestProfile(db, c.req.param('id'), {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, guest })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const assignTagBodySchema = z.object({
	tagId: z.string().trim().min(1).max(128),
})

operatorReservationsGuestsRoutes.post(
	'/:id/tags',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, assignTagBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const tags = await assignGuestTag(
				db,
				c.req.param('id'),
				parsed.data.tagId,
			)
			return json({ ok: true, orgId: ctx.orgId, tags })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.delete(
	'/:id/tags/:tagId',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		try {
			const db = await getTenantDb(ctx.orgId)
			const tags = await removeGuestTag(
				db,
				c.req.param('id'),
				c.req.param('tagId'),
			)
			return json({ ok: true, orgId: ctx.orgId, tags })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const addNoteBodySchema = z.object({
	body: z.string().trim().min(1).max(2000),
	pinned: z.boolean().optional(),
})

operatorReservationsGuestsRoutes.post(
	'/:id/notes',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, addNoteBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const note = await addGuestNote(db, c.req.param('id'), {
				...parsed.data,
				actorId: ctx.userId,
			})
			return json({ ok: true, orgId: ctx.orgId, note }, 201)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const updateNoteBodySchema = z
	.object({
		body: z.string().trim().min(1).max(2000).optional(),
		pinned: z.boolean().optional(),
	})
	.refine((v) => Object.keys(v).length > 0, { message: 'No changes' })

operatorReservationsGuestsRoutes.patch(
	'/:id/notes/:noteId',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, updateNoteBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const note = await updateGuestNote(
				db,
				c.req.param('id'),
				c.req.param('noteId'),
				parsed.data,
			)
			return json({ ok: true, orgId: ctx.orgId, note })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsGuestsRoutes.delete(
	'/:id/notes/:noteId',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		try {
			const db = await getTenantDb(ctx.orgId)
			const result = await deleteGuestNote(
				db,
				c.req.param('id'),
				c.req.param('noteId'),
			)
			return json({ ok: true, orgId: ctx.orgId, ...result })
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
			// The guest is the organization's; their bookings show at the member's locations only.
			return json({
				ok: true,
				orgId: ctx.orgId,
				...summary,
				reservations: filterReservationsLocations(ctx, summary.reservations),
			})
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
	.loose()

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
