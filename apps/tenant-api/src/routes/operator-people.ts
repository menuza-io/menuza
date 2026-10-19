import { getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	handleRouteError,
	HttpError,
	json,
	readJsonBody,
	readQuery,
} from '../lib/http.ts'
import { ensureActiveOrgInNodeRegion } from '../lib/reservations-guard.ts'
import {
	DEFAULT_LAPSED_DAYS,
	getPersonProfile,
	listPeople,
	mergePeople,
	PEOPLE_ACCOUNT_FILTERS,
	PEOPLE_PAGE_SIZE,
	PEOPLE_SORTS,
	parsePersonKey,
	requireDiningFacet,
	requireDiningWrite,
	resolveGuestId,
	resolvePerson,
	updatePerson,
	type PeopleAccess,
} from '../services/people-service.ts'
import { listPersonOrders } from '../services/people-orders-service.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import {
	exportGuestProfile,
	type SerializedGuestTag,
} from '../services/rsv-guest-service.ts'
import {
	addGuestNote,
	assignGuestTag,
	createGuestTag,
	deleteGuestNote,
	GUEST_TAG_CATEGORIES,
	listGuestTags,
	removeGuestTag,
	updateGuestNote,
} from '../services/rsv-guestbook-service.ts'
import { authenticateOperator } from './operator.ts'

/**
 * `/operator/people`: the Customers screen's API. One browser-direct token
 * (`scope: 'people'`, minted by the App) carries the claims for both facets:
 *  - `peopleCustomers`: contact, orders summary and consent of customers;
 *  - `peopleDining`: `flags` (counters, non-sensitive tags) or `full` (the
 *    reservation guest read grant: allergy, sensitive tags, notes);
 *  - `canUpdate`, `canUpdateGuest`, `canDelete`: the matching writes.
 * No claim means no facet; the request can never widen it. Guestbook data is
 * organization-wide, so location scoping does not apply (as on the guests API).
 */
export const operatorPeopleRoutes = new Hono()

type PeopleContext = { access: PeopleAccess; orgId: string }

async function authenticate(
	c: Context,
): Promise<PeopleContext | { response: Response }> {
	let auth
	try {
		auth = await authenticateOperator(c, 'people')
	} catch (response) {
		return { response: response as Response }
	}
	const dining =
		auth.peopleDining === 'full' || auth.peopleDining === 'flags'
			? auth.peopleDining
			: 'none'
	const access: PeopleAccess = {
		actorId: auth.sub ?? 'operator',
		customers: auth.peopleCustomers === true,
		dining,
		canUpdateCustomers:
			auth.peopleCustomers === true && auth.canUpdate === true,
		canUpdateDining: dining === 'full' && auth.canUpdateGuest === true,
		canDelete: auth.canDelete === true,
	}
	if (!access.customers && access.dining === 'none') {
		return { response: json({ error: 'insufficient_permissions' }, 403) }
	}
	const orgErr = await ensureActiveOrgInNodeRegion({ orgId: auth.orgId })
	if (orgErr) return { response: orgErr }
	return { access, orgId: auth.orgId }
}

function fail(error: unknown): Response {
	return handleRouteError(error)
}

const flag = z
	.enum(['1', 'true', '0', 'false'])
	.optional()
	.transform((v) => v === '1' || v === 'true')

const listQuerySchema = z.object({
	q: z.string().trim().max(120).optional(),
	vip: flag,
	allergy: flag,
	lapsed: flag,
	lapsedDays: z.coerce.number().int().min(1).max(3650).optional(),
	upcoming: flag,
	noShowRisk: flag,
	hasDining: flag,
	account: z.enum(PEOPLE_ACCOUNT_FILTERS).optional(),
	includeWalkIns: flag,
	sort: z.enum(PEOPLE_SORTS).optional(),
	cursor: z.string().trim().max(512).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
})

operatorPeopleRoutes.get('/', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const q = readQuery(c, listQuerySchema)
	if ('error' in q) return q.error
	try {
		const db = await getTenantDb(ctx.orgId)
		const page = await listPeople(db, ctx.access, {
			...q.data,
			lapsedDays: q.data.lapsedDays ?? DEFAULT_LAPSED_DAYS,
			limit: q.data.limit ?? PEOPLE_PAGE_SIZE,
		})
		return json({ ok: true, orgId: ctx.orgId, ...page })
	} catch (error) {
		return fail(error)
	}
})

// ----- tags catalog (before `/:key` so it is not read as a key) -------------

operatorPeopleRoutes.get('/tags', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	try {
		requireDiningFacet(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const all = await listGuestTags(db)
		const tags =
			ctx.access.dining === 'full' ? all : all.filter((t) => !t.sensitive)
		return json({ ok: true, orgId: ctx.orgId, tags })
	} catch (error) {
		return fail(error)
	}
})

const createTagSchema = z.object({
	name: z.string().trim().min(1).max(60),
	category: z.enum(GUEST_TAG_CATEGORIES).optional(),
	colorToken: z.string().trim().min(1).max(32).optional(),
})

operatorPeopleRoutes.post('/tags', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const body = await readJsonBody(c, createTagSchema)
	if ('error' in body) return body.error
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const tag = await createGuestTag(db, {
			...body.data,
			actorId: ctx.access.actorId,
		})
		return json({ ok: true, orgId: ctx.orgId, tag }, 201)
	} catch (error) {
		return fail(error)
	}
})

const mergeSchema = z.object({
	keepKey: z.string().trim().min(1).max(160),
	mergeKey: z.string().trim().min(1).max(160),
	keepVersion: z.number().int().min(1).optional(),
})

operatorPeopleRoutes.post('/merge', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const body = await readJsonBody(c, mergeSchema)
	if ('error' in body) return body.error
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const merged = await mergePeople(db, ctx.access, body.data)
		return json({ ok: true, orgId: ctx.orgId, ...merged })
	} catch (error) {
		return fail(error)
	}
})

// ----- one person ------------------------------------------------------------

operatorPeopleRoutes.get('/:key', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	try {
		const db = await getTenantDb(ctx.orgId)
		const profile = await getPersonProfile(db, ctx.access, c.req.param('key'))
		return json({ ok: true, orgId: ctx.orgId, ...profile })
	} catch (error) {
		return fail(error)
	}
})

const ordersQuerySchema = z.object({
	cursor: z.string().trim().max(512).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
})

/**
 * All of one customer's orders, newest first, keyset-paged. Needs the
 * customers facet claim (a host-only token is refused). See
 * `listPersonOrders` for the matching rule.
 */
operatorPeopleRoutes.get('/:key/orders', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const q = readQuery(c, ordersQuerySchema)
	if ('error' in q) return q.error
	try {
		const db = await getTenantDb(ctx.orgId)
		const page = await listPersonOrders(
			db,
			ctx.access,
			c.req.param('key'),
			q.data,
		)
		return json({ ok: true, orgId: ctx.orgId, ...page })
	} catch (error) {
		return fail(error)
	}
})

const patchSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		email: z
			.string()
			.trim()
			.max(255)
			.nullable()
			.optional()
			.transform((v) => (v ? v : null))
			.pipe(z.string().email().nullable()),
		phone: z.string().trim().max(32).nullable().optional(),
		allergyNotes: z.string().max(1000).nullable().optional(),
		expectedVersion: z.number().int().min(1).optional(),
	})
	.strict()

operatorPeopleRoutes.patch('/:key', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return json({ error: 'invalid_json' }, 400)
	}
	// Only fields the caller sent are written; `email: ''` clears the email.
	const sent =
		raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	const parsed = patchSchema.safeParse(raw)
	if (!parsed.success) {
		return json(
			{
				error: 'validation_error',
				issues: parsed.error.issues.slice(0, 20).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			400,
		)
	}
	const data = parsed.data
	const patch = {
		...(data.name !== undefined ? { name: data.name } : {}),
		...('email' in sent ? { email: data.email ?? null } : {}),
		...(data.phone !== undefined ? { phone: data.phone } : {}),
		...(data.allergyNotes !== undefined
			? { allergyNotes: data.allergyNotes }
			: {}),
		...(data.expectedVersion !== undefined
			? { expectedVersion: data.expectedVersion }
			: {}),
	}
	try {
		const db = await getTenantDb(ctx.orgId)
		const key = await updatePerson(db, ctx.access, c.req.param('key'), patch)
		const profile = await getPersonProfile(db, ctx.access, key)
		return json({ ok: true, orgId: ctx.orgId, ...profile })
	} catch (error) {
		return fail(error)
	}
})

const assignTagSchema = z.object({ tagId: z.string().trim().min(1).max(128) })

operatorPeopleRoutes.post('/:key/tags', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const body = await readJsonBody(c, assignTagSchema)
	if ('error' in body) return body.error
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const tags = await assignGuestTag(db, guestId, body.data.tagId)
		return json({ ok: true, orgId: ctx.orgId, tags: safeTags(tags) })
	} catch (error) {
		return fail(error)
	}
})

operatorPeopleRoutes.delete('/:key/tags/:tagId', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const tags = await removeGuestTag(db, guestId, c.req.param('tagId'))
		return json({ ok: true, orgId: ctx.orgId, tags: safeTags(tags) })
	} catch (error) {
		return fail(error)
	}
})

function safeTags(tags: SerializedGuestTag[]) {
	return tags.map((t) => ({
		id: t.id,
		name: t.name,
		category: t.category,
		colorToken: t.colorToken,
	}))
}

const addNoteSchema = z.object({
	body: z.string().trim().min(1).max(2000),
	pinned: z.boolean().optional(),
})

operatorPeopleRoutes.post('/:key/notes', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const body = await readJsonBody(c, addNoteSchema)
	if ('error' in body) return body.error
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const note = await addGuestNote(db, guestId, {
			...body.data,
			actorId: ctx.access.actorId,
		})
		return json({ ok: true, orgId: ctx.orgId, note }, 201)
	} catch (error) {
		return fail(error)
	}
})

const updateNoteSchema = z
	.object({
		body: z.string().trim().min(1).max(2000).optional(),
		pinned: z.boolean().optional(),
	})
	.refine((v) => Object.keys(v).length > 0, { message: 'No changes' })

operatorPeopleRoutes.patch('/:key/notes/:noteId', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const body = await readJsonBody(c, updateNoteSchema)
	if ('error' in body) return body.error
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const note = await updateGuestNote(
			db,
			guestId,
			c.req.param('noteId'),
			body.data,
		)
		return json({ ok: true, orgId: ctx.orgId, note })
	} catch (error) {
		return fail(error)
	}
})

operatorPeopleRoutes.delete('/:key/notes/:noteId', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	try {
		requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const result = await deleteGuestNote(db, guestId, c.req.param('noteId'))
		return json({ ok: true, orgId: ctx.orgId, ...result })
	} catch (error) {
		return fail(error)
	}
})

operatorPeopleRoutes.get('/:key/export', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	const sensitive = c.req.query('includeSensitive')?.toLowerCase()
	const includeSensitive =
		sensitive === '1' || sensitive === 'true' || sensitive === 'yes'
	try {
		requireDiningFacet(ctx.access, 'full')
		if (includeSensitive) requireDiningWrite(ctx.access)
		const db = await getTenantDb(ctx.orgId)
		const guestId = await resolveGuestId(db, ctx.access, c.req.param('key'))
		const exported = await exportGuestProfile(db, {
			guestId,
			actorId: ctx.access.actorId,
			includeSensitive,
		})
		return json({ ok: true, orgId: ctx.orgId, ...exported })
	} catch (error) {
		return fail(error)
	}
})

/**
 * The one erase flow: customer row, linked guests, subscriptions, tokens, order
 * contact fields, waitlist, notify and voice data (`erasePerson`). Needs a
 * token minted with `canDelete`.
 */
operatorPeopleRoutes.post('/:key/erase', async (c) => {
	const ctx = await authenticate(c)
	if ('response' in ctx) return ctx.response
	if (!ctx.access.canDelete) {
		return json({ error: 'Forbidden' }, 403)
	}
	const parsedKey = parsePersonKey(c.req.param('key'))
	if (!parsedKey) return json({ error: 'not_found' }, 404)
	try {
		const db = await getTenantDb(ctx.orgId)
		// Resolve first so a key that no longer exists is a plain 404, and so a
		// caller only erases what the claims let them see.
		const person = await resolvePerson(db, ctx.access, c.req.param('key'))
		const target = person.customer
			? { customerId: person.customer.id }
			: { guestId: person.guest!.id }
		const { guest: ignoredGuest, ...counts } = await erasePerson(db, target, {
			actorId: ctx.access.actorId,
		})
		return json({ ok: true, orgId: ctx.orgId, ...counts })
	} catch (error) {
		if (error instanceof HttpError) return error.toResponse()
		return fail(error)
	}
})
