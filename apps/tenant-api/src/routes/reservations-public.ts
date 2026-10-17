import { createHash } from 'node:crypto'
import { getTenantDb, rsvHolds } from '@repo/tenant-db'
import { and, eq, gt } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { HttpError, json } from '../lib/http.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	clientIpHash,
	deriveManageToken,
	enforceDurableLimit,
	enforceMemoryLimit,
	handlePublicError,
	hashHoldToken,
	isWellFormedHoldToken,
	newHoldToken,
	notFoundResponse,
	parseManageTokenId,
	purgeStaleRateCounters,
	randomFakeId,
	readCapabilityToken,
	readClient,
	readIdempotencyKey,
	readPublicBody,
	readPublicQuery,
	resolvePublicOrg,
	type ResolvedPublicOrg,
	verificationFailedResponse,
	verifyManageToken,
	verifyPublicChallenge,
} from '../lib/reservations-public-auth.ts'
import { hashIdempotencyPayload } from '../lib/reservations-write.ts'
import { getBearerToken } from '../lib/secrets.ts'
import {
	createHold,
	findActiveHoldByTokenHash,
	releaseHoldByTokenHash,
} from '../services/rsv-hold-service.ts'
import { buildReservationIcs } from '../services/rsv-ics.ts'
import {
	bookFromHold,
	buildManageView,
	createLargePartyRequest,
	findContextLocation,
	generatePublicConfirmationCode,
	guestCancelReservation,
	guestConfirmReservation,
	guestModifyReservation,
	guestRunningLate,
	listCustomerReservations,
	loadReservationById,
	normalizePublicPhone,
	summarizeReservation,
} from '../services/rsv-public-booking-service.ts'
import {
	getPublicAvailability,
	getPublicCalendar,
	getPublicConfig,
	requireBookableLocation,
} from '../services/rsv-public-service.ts'
import { authenticateCustomer } from './auth.ts'
import { registerPublicWaitlistRoutes } from './reservations-public-waitlist.ts'

export const reservationsPublicRoutes = new Hono()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Manage links stay valid this long after the booking ends. */
const MANAGE_TOKEN_GRACE_MS = 7 * DAY

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const dateField = z
	.string()
	.regex(DATE_RE)
	.refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
const idField = z.string().trim().min(1).max(128)
const localMinField = z.number().int().min(0).max(2880)

function isoNow(now: number) {
	return new Date(now).toISOString()
}

/** Every route runs inside this: kills stray HttpErrors into their JSON bodies. */
function guarded(
	handler: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
	return async (c) => {
		try {
			return await handler(c)
		} catch (error) {
			return handlePublicError(error)
		}
	}
}

function methodNotAllowed(_context?: Context) {
	return Response.json(
		{ error: 'not_found' },
		{
			status: 404,
			headers: { 'Cache-Control': 'private, no-store', Allow: 'POST' },
		},
	)
}

function readLocale(c: Context): string | null {
	const explicit = c.req.query('locale')?.trim()
	const raw = explicit || c.req.header('Accept-Language')?.split(',')[0]?.trim()
	if (!raw) return null
	const base = raw.split(';')[0]?.trim().toLowerCase().split('-')[0]
	return base && /^[a-z]{2,3}$/.test(base) ? base : null
}

function checkPartySize(partySize: number) {
	if (!Number.isInteger(partySize) || partySize < 1 || partySize > 99) {
		throw new HttpError(400, 'party_size_invalid')
	}
}

/**
 * A presented customer token must be valid for this organization; an invalid
 * or cross-organization token is refused instead of being ignored.
 */
async function optionalCustomer(
	c: Context,
	org: PublishedOrganization,
): Promise<{ customerId: string | null } | { error: Response }> {
	if (!getBearerToken(c.req.header('Authorization'))) {
		return { customerId: null }
	}
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== org.id) {
			return { error: json({ error: 'forbidden' }, 403) }
		}
		return { customerId: auth.customerId }
	} catch (thrown) {
		if (thrown instanceof Response) return { error: thrown }
		throw thrown
	}
}

function subjectHash(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

function emptyToNull(value: unknown) {
	return typeof value === 'string' && value.trim() === '' ? null : value
}

// ---------------------------------------------------------------------------
// Request schemas (validation errors carry field paths only)
// ---------------------------------------------------------------------------

const guestSchema = z.object({
	firstName: z.string().trim().min(1).max(60),
	lastName: z.string().trim().max(60).default(''),
	phone: z
		.string()
		.trim()
		.min(1)
		.max(32)
		.refine((value) => normalizePublicPhone(value) !== null),
	email: z.preprocess(
		emptyToNull,
		z.string().trim().email().max(160).nullable().optional(),
	),
})

const slotSchema = z.object({
	date: dateField,
	localMin: localMinField,
	partySize: z.number().int().min(1).max(99),
	serviceId: idField.nullish(),
})

const bookingDetailsShape = {
	guest: guestSchema,
	occasionTagId: idField.nullish(),
	requests: z.preprocess(emptyToNull, z.string().max(1000).nullish()),
	dietary: z.preprocess(emptyToNull, z.string().max(500).nullish()),
	areaPref: z.preprocess(emptyToNull, idField.nullish()),
	smsOptIn: z.boolean().default(false),
	marketing: z
		.object({
			email: z.boolean().optional(),
			sms: z.boolean().optional(),
			textVersion: z.string().max(64).optional(),
		})
		.nullish(),
	policyAccepted: z
		.object({ termsVersion: z.string().max(64).optional() })
		.nullish(),
	locale: z.string().trim().min(2).max(10).default('en'),
	website: z.string().max(500).optional(),
	turnstileToken: z.string().max(2048).nullish(),
}

const holdSchema = z.object({
	locationId: idField,
	slot: slotSchema,
	areaPref: z.preprocess(emptyToNull, idField.nullish()),
	replaceHoldToken: z.string().max(256).nullish(),
	website: z.string().max(500).optional(),
	turnstileToken: z.string().max(2048).nullish(),
})

const bookSchema = z.object({
	holdToken: z.string().min(8).max(256),
	...bookingDetailsShape,
})

const requestSchema = z.object({
	locationId: idField,
	slot: slotSchema,
	...bookingDetailsShape,
})

const releaseSchema = z.object({ holdToken: z.string().max(256).optional() })

const availabilityQuerySchema = z.object({
	locationId: idField,
	date: dateField,
	partySize: z.coerce.number().int(),
	localMin: z.coerce.number().int().min(0).max(2880).optional(),
})

const calendarQuerySchema = z.object({
	locationId: idField,
	partySize: z.coerce.number().int(),
	from: dateField,
	to: dateField,
})

const manageAvailabilityQuerySchema = z.object({
	date: dateField.optional(),
	partySize: z.coerce.number().int().optional(),
	localMin: z.coerce.number().int().min(0).max(2880).optional(),
})

const modifySchema = z.object({
	date: dateField.optional(),
	localMin: localMinField,
	partySize: z.number().int().min(1).max(99).optional(),
})

const lateSchema = z.object({ minutes: z.number().int().min(1).max(180) })

const emptyBodySchema = z.object({}).passthrough()

function bookingInputFrom(
	data: z.infer<typeof bookSchema | typeof requestSchema>,
) {
	return {
		guest: {
			firstName: data.guest.firstName,
			lastName: data.guest.lastName,
			phone: data.guest.phone,
			email: data.guest.email ?? null,
			locale: data.locale,
		},
		occasionTagId: data.occasionTagId ?? null,
		requests: data.requests ?? null,
		dietary: data.dietary ?? null,
		areaPref: data.areaPref ?? null,
		smsOptIn: data.smsOptIn,
		marketing: Boolean(data.marketing?.email || data.marketing?.sms),
		policyAccepted: Boolean(data.policyAccepted),
	}
}

async function gate(
	c: Context,
	scope: 'booking' | 'manage',
	limit?: { name: string; max: number; windowMs: number },
): Promise<
	{ ok: true; value: ResolvedPublicOrg } | { ok: false; response: Response }
> {
	const resolved = await resolvePublicOrg(c, scope)
	if (!resolved.ok) return resolved
	if (limit) {
		const limited = enforceMemoryLimit(c, limit.name, limit.max, limit.windowMs)
		if (limited) return { ok: false, response: limited }
	}
	return resolved
}

function fakeReservation(channel: string, status: string) {
	return {
		reservation: {
			id: randomFakeId('rsv'),
			confirmationCode: generatePublicConfirmationCode(),
			status,
			channel,
		},
		manageToken: `rsv_m_${randomFakeId('x').replace(/-/g, '')}.${randomFakeId('y').replace(/-/g, '')}`,
	}
}

// ---------------------------------------------------------------------------
// Discovery: config, availability, calendar
// ---------------------------------------------------------------------------

reservationsPublicRoutes.get(
	'/config',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'config',
			max: 120,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const db = await getTenantDb(g.value.org.id)
		const config = await getPublicConfig(db, g.value.context, readLocale(c))
		return json({ ...config, now: isoNow(Date.now()) })
	}),
)

reservationsPublicRoutes.get(
	'/availability',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'availability',
			max: 60,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const query = readPublicQuery(c, availabilityQuerySchema)
		if ('error' in query) return query.error
		checkPartySize(query.data.partySize)

		const db = await getTenantDb(g.value.org.id)
		const location = await requireBookableLocation(
			db,
			g.value.context,
			query.data.locationId,
		)
		const now = Date.now()
		const result = await getPublicAvailability(db, {
			locationId: query.data.locationId,
			date: query.data.date,
			partySize: query.data.partySize,
			localMin: query.data.localMin ?? null,
			locale: readLocale(c),
			now,
			location,
			features: g.value.context.features,
		})

		// The body's waitlist and notify-me offers follow these flags, which no
		// day or settings version tracks, so a flag change must change the tag.
		const { online, waitlist } = g.value.context.features
		const flagBits = `${online ? 1 : 0}${waitlist ? 1 : 0}`
		const etag = `"${result.dayVersion}.${result.settingsVersion}.${flagBits}"`
		const headers = {
			ETag: etag,
			'Cache-Control': 'private, max-age=0',
		}
		// A hold lapsing changes capacity without bumping the day version, so
		// a day with live holds is never answered from the client's cache.
		const liveHold = await db
			.select({ id: rsvHolds.id })
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.locationId, query.data.locationId),
					eq(rsvHolds.businessDate, query.data.date),
					eq(rsvHolds.status, 'active'),
					gt(rsvHolds.expiresAt, now),
				),
			)
			.get()
		const presented = c.req.header('If-None-Match')
		if (
			!liveHold &&
			presented &&
			presented.split(',').some((v) => v.trim() === etag)
		) {
			return new Response(null, { status: 304, headers })
		}
		return Response.json(result, { status: 200, headers })
	}),
)

reservationsPublicRoutes.get(
	'/calendar',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'calendar',
			max: 30,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const query = readPublicQuery(c, calendarQuerySchema)
		if ('error' in query) return query.error
		checkPartySize(query.data.partySize)
		if (query.data.to < query.data.from) {
			throw new HttpError(400, 'invalid', undefined, {
				issues: [{ path: 'to', code: 'too_small' }],
			})
		}
		const db = await getTenantDb(g.value.org.id)
		const location = await requireBookableLocation(
			db,
			g.value.context,
			query.data.locationId,
		)
		const result = await getPublicCalendar(db, {
			locationId: query.data.locationId,
			from: query.data.from,
			to: query.data.to,
			partySize: query.data.partySize,
			location,
		})
		return json(result)
	}),
)

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

reservationsPublicRoutes.post(
	'/holds',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'holds',
			max: 10,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const { org } = g.value
		const body = await readPublicBody(c, holdSchema)
		if ('error' in body) return body.error
		const client = readClient(c)

		if (body.data.website) {
			const now = Date.now()
			return json(
				{
					holdToken: newHoldToken(),
					expiresAt: isoNow(now + 7 * MINUTE),
					now: isoNow(now),
					slot: body.data.slot,
				},
				201,
			)
		}

		const customer = await optionalCustomer(c, org)
		if ('error' in customer) return customer.error
		const verified = await verifyPublicChallenge(c, body.data.turnstileToken, {
			hasCustomer: customer.customerId !== null,
		})
		if (!verified) return verificationFailedResponse()

		const db = await getTenantDb(org.id)
		const ipHash = clientIpHash(c)
		const limited = await enforceDurableLimit(db, {
			bucket: 'holds_ip',
			subjectHash: ipHash,
			max: 10,
			windowMs: 10 * MINUTE,
		})
		if (limited) return limited
		await purgeStaleRateCounters(db).catch(() => undefined)

		await requireBookableLocation(db, g.value.context, body.data.locationId)
		const holdToken = newHoldToken()
		const replace = body.data.replaceHoldToken
		const created = await createHold({
			orgId: org.id,
			locationId: body.data.locationId,
			slot: body.data.slot,
			areaPref: body.data.areaPref ?? null,
			tokenHash: hashHoldToken(holdToken),
			replaceTokenHash: isWellFormedHoldToken(replace)
				? hashHoldToken(replace)
				: null,
			source: client.channel === 'native' ? 'native' : 'web',
			ipHash,
		})
		return json(
			{
				holdToken,
				expiresAt: isoNow(created.expiresAt),
				now: isoNow(created.now),
				locationId: created.locationId,
				slot: created.slot,
			},
			201,
		)
	}),
)

reservationsPublicRoutes.get(
	'/holds/current',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'holds-current',
			max: 60,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const token = readCapabilityToken(c)
		if (!isWellFormedHoldToken(token)) return notFoundResponse()
		const now = Date.now()
		const hold = await findActiveHoldByTokenHash(
			g.value.org.id,
			hashHoldToken(token),
			now,
		)
		if (!hold) return notFoundResponse()
		return json({
			locationId: hold.locationId,
			slot: {
				date: hold.businessDate,
				localMin: hold.localStartMin,
				partySize: hold.partySize,
				serviceId: hold.serviceId,
			},
			expiresAt: isoNow(hold.expiresAt),
			now: isoNow(now),
		})
	}),
)

reservationsPublicRoutes.post(
	'/holds/release',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'holds-release',
			max: 30,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const raw = await c.req.json().catch(() => ({}))
		const parsed = releaseSchema.safeParse(raw ?? {})
		if (!parsed.success) return notFoundResponse()
		const token = parsed.data.holdToken ?? readCapabilityToken(c)
		if (!isWellFormedHoldToken(token)) return notFoundResponse()
		const released = await releaseHoldByTokenHash(
			g.value.org.id,
			hashHoldToken(token),
		)
		if (!released) return notFoundResponse()
		return json({ released: true, now: isoNow(Date.now()) })
	}),
)

// ---------------------------------------------------------------------------
// Booking and large-party requests
// ---------------------------------------------------------------------------

function missingIdempotencyKey() {
	return new HttpError(400, 'invalid', undefined, {
		issues: [{ path: 'Idempotency-Key', code: 'required' }],
	})
}

async function bookingResponse(
	g: ResolvedPublicOrg,
	reservationId: string,
	status: 201 | 200,
) {
	const db = await getTenantDb(g.org.id)
	const row = await loadReservationById(db, reservationId)
	if (!row) throw new HttpError(404, 'not_found')
	return json(
		{
			reservation: {
				...summarizeReservation(row, g.context),
				confirmationCode: row.confirmationCode,
			},
			manageToken: deriveManageToken(g.org.id, row.id, row.manageTokenVersion),
		},
		status,
	)
}

reservationsPublicRoutes.post(
	'/',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'book',
			max: 10,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		const { org } = g.value
		const body = await readPublicBody(c, bookSchema)
		if ('error' in body) return body.error
		const client = readClient(c)

		if (body.data.website) {
			return json(fakeReservation(client.channel, 'booked'), 201)
		}

		const key = readIdempotencyKey(c)
		if (!key) throw missingIdempotencyKey()
		const customer = await optionalCustomer(c, org)
		if ('error' in customer) return customer.error

		const db = await getTenantDb(org.id)
		const ipHash = clientIpHash(c)
		const limited = await enforceDurableLimit(db, {
			bucket: 'book_ip',
			subjectHash: ipHash,
			max: 20,
			windowMs: DAY,
		})
		if (limited) return limited

		const { reservationId } = await bookFromHold({
			orgId: org.id,
			holdTokenHash: hashHoldToken(body.data.holdToken),
			input: bookingInputFrom(body.data),
			client: client.client,
			channel: client.channel,
			customerId: customer.customerId,
			ipHash,
			idempotencyKey: key,
			requestHash: hashIdempotencyPayload(body.data),
		})
		return bookingResponse(g.value, reservationId, 201)
	}),
)

reservationsPublicRoutes.post(
	'/requests',
	guarded(async (c) => {
		const g = await gate(c, 'booking', {
			name: 'requests',
			max: 5,
			windowMs: 10 * MINUTE,
		})
		if (!g.ok) return g.response
		const { org } = g.value
		const body = await readPublicBody(c, requestSchema)
		if ('error' in body) return body.error
		const client = readClient(c)

		if (body.data.website) {
			return json(fakeReservation(client.channel, 'requested'), 201)
		}

		const key = readIdempotencyKey(c)
		if (!key) throw missingIdempotencyKey()
		const customer = await optionalCustomer(c, org)
		if ('error' in customer) return customer.error
		const verified = await verifyPublicChallenge(c, body.data.turnstileToken, {
			hasCustomer: customer.customerId !== null,
		})
		if (!verified) return verificationFailedResponse()

		const db = await getTenantDb(org.id)
		const ipHash = clientIpHash(c)
		const limited = await enforceDurableLimit(db, {
			bucket: 'requests_ip',
			subjectHash: ipHash,
			max: 5,
			windowMs: 10 * MINUTE,
		})
		if (limited) return limited
		await requireBookableLocation(db, g.value.context, body.data.locationId)

		const { reservationId } = await createLargePartyRequest({
			orgId: org.id,
			locationId: body.data.locationId,
			input: { ...bookingInputFrom(body.data), slot: body.data.slot },
			client: client.client,
			channel: client.channel,
			customerId: customer.customerId,
			ipHash,
			idempotencyKey: key,
			requestHash: hashIdempotencyPayload(body.data),
		})
		return bookingResponse(g.value, reservationId, 201)
	}),
)

// ---------------------------------------------------------------------------
// Manage (capability token)
// ---------------------------------------------------------------------------

type ManagedReservation = {
	g: ResolvedPublicOrg
	row: NonNullable<Awaited<ReturnType<typeof loadReservationById>>>
	now: number
}

/** Resolves a manage token to its reservation; anything wrong answers the same 404. */
async function resolveManaged(
	c: Context,
	limit: { name: string; max: number; windowMs: number },
	options: { allowQuery?: boolean } = {},
): Promise<
	{ ok: true; value: ManagedReservation } | { ok: false; response: Response }
> {
	const g = await gate(c, 'manage', limit)
	if (!g.ok) return g
	const token = readCapabilityToken(c, options)
	const id = parseManageTokenId(token)
	if (!token || !id) return { ok: false, response: notFoundResponse() }
	const db = await getTenantDb(g.value.org.id)
	const row = await loadReservationById(db, id)
	const now = Date.now()
	if (
		!row ||
		!verifyManageToken(g.value.org.id, row.id, row.manageTokenVersion, token) ||
		now > row.endAt + MANAGE_TOKEN_GRACE_MS
	) {
		return { ok: false, response: notFoundResponse() }
	}
	return { ok: true, value: { g: g.value, row, now } }
}

async function resolveManagedMutation(c: Context) {
	const managed = await resolveManaged(c, {
		name: 'manage-write',
		max: 30,
		windowMs: MINUTE,
	})
	if (!managed.ok) return managed
	const { g, row } = managed.value
	const db = await getTenantDb(g.org.id)
	const limited = await enforceDurableLimit(db, {
		bucket: 'manage_mutation',
		subjectHash: subjectHash(row.id),
		max: 30,
		windowMs: HOUR,
	})
	if (limited) return { ok: false as const, response: limited }
	return managed
}

async function manageViewResponse(g: ResolvedPublicOrg, reservationId: string) {
	const db = await getTenantDb(g.org.id)
	const fresh = await loadReservationById(db, reservationId)
	if (!fresh) return notFoundResponse()
	return json(await buildManageView(db, g.context, fresh, Date.now()))
}

async function readOptionalBody<S extends z.ZodTypeAny>(
	c: Context,
	schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
	const text = await c.req.text()
	if (!text.trim()) return { data: schema.parse({}) as z.infer<S> }
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return {
			error: Response.json(
				{ error: 'invalid', issues: [{ path: '', code: 'invalid_json' }] },
				{ status: 400, headers: { 'Cache-Control': 'private, no-store' } },
			),
		}
	}
	const result = schema.safeParse(raw ?? {})
	if (!result.success) {
		return {
			error: Response.json(
				{
					error: 'invalid',
					issues: result.error.issues.slice(0, 20).map((issue) => ({
						path: issue.path.join('.'),
						code: issue.code,
					})),
				},
				{ status: 400, headers: { 'Cache-Control': 'private, no-store' } },
			),
		}
	}
	return { data: result.data as z.infer<S> }
}

reservationsPublicRoutes.get(
	'/manage',
	guarded(async (c) => {
		const managed = await resolveManaged(c, {
			name: 'manage-read',
			max: 60,
			windowMs: MINUTE,
		})
		if (!managed.ok) return managed.response
		const { g, row, now } = managed.value
		const db = await getTenantDb(g.org.id)
		return json(await buildManageView(db, g.context, row, now))
	}),
)

reservationsPublicRoutes.get(
	'/manage/availability',
	guarded(async (c) => {
		const managed = await resolveManaged(c, {
			name: 'manage-availability',
			max: 30,
			windowMs: MINUTE,
		})
		if (!managed.ok) return managed.response
		const { g, row, now } = managed.value
		const query = readPublicQuery(c, manageAvailabilityQuerySchema)
		if ('error' in query) return query.error
		const partySize = query.data.partySize ?? row.partySize
		checkPartySize(partySize)
		const db = await getTenantDb(g.org.id)
		const location = await requireBookableLocation(
			db,
			g.context,
			row.locationId,
		)
		const result = await getPublicAvailability(db, {
			locationId: row.locationId,
			date: query.data.date ?? row.businessDate,
			partySize,
			localMin: query.data.localMin ?? null,
			locale: readLocale(c),
			now,
			excludeReservationId: row.id,
			location,
			features: g.context.features,
		})
		return json(result)
	}),
)

reservationsPublicRoutes.post(
	'/manage/modify',
	guarded(async (c) => {
		const managed = await resolveManagedMutation(c)
		if (!managed.ok) return managed.response
		const body = await readOptionalBody(c, modifySchema)
		if ('error' in body) return body.error
		const { g, row } = managed.value
		await guestModifyReservation({
			orgId: g.org.id,
			reservationId: row.id,
			input: body.data,
		})
		return manageViewResponse(g, row.id)
	}),
)

reservationsPublicRoutes.post(
	'/manage/cancel',
	guarded(async (c) => {
		const managed = await resolveManagedMutation(c)
		if (!managed.ok) return managed.response
		const body = await readOptionalBody(c, emptyBodySchema)
		if ('error' in body) return body.error
		const { g, row } = managed.value
		await guestCancelReservation({ orgId: g.org.id, reservationId: row.id })
		return manageViewResponse(g, row.id)
	}),
)

reservationsPublicRoutes.post(
	'/manage/confirm',
	guarded(async (c) => {
		const managed = await resolveManagedMutation(c)
		if (!managed.ok) return managed.response
		const body = await readOptionalBody(c, emptyBodySchema)
		if ('error' in body) return body.error
		const { g, row } = managed.value
		await guestConfirmReservation({ orgId: g.org.id, reservationId: row.id })
		return manageViewResponse(g, row.id)
	}),
)

for (const path of ['/manage/late', '/manage/running-late']) {
	reservationsPublicRoutes.post(
		path,
		guarded(async (c) => {
			const managed = await resolveManagedMutation(c)
			if (!managed.ok) return managed.response
			const body = await readOptionalBody(c, lateSchema)
			if ('error' in body) return body.error
			const { g, row } = managed.value
			await guestRunningLate({
				orgId: g.org.id,
				reservationId: row.id,
				minutes: body.data.minutes,
			})
			return manageViewResponse(g, row.id)
		}),
	)
}

for (const path of ['/manage/calendar.ics', '/manage/ics']) {
	reservationsPublicRoutes.get(
		path,
		guarded(async (c) => {
			const managed = await resolveManaged(
				c,
				{ name: 'manage-ics', max: 30, windowMs: MINUTE },
				{ allowQuery: true },
			)
			if (!managed.ok) return managed.response
			const { g, row, now } = managed.value
			const location = findContextLocation(g.context, row.locationId)
			const body = buildReservationIcs({
				reservationId: row.id,
				confirmationCode: row.confirmationCode,
				restaurantName: g.context.organization.name,
				locationName: location?.name ?? null,
				address: location?.address?.formattedAddress ?? null,
				startAt: row.startAt,
				endAt: row.endAt,
				partySize: row.partySize,
				now,
			})
			return new Response(body, {
				status: 200,
				headers: {
					'Content-Type': 'text/calendar; charset=utf-8',
					'Content-Disposition': 'attachment; filename="reservation.ics"',
					'Cache-Control': 'private, no-store',
					'Referrer-Policy': 'no-referrer',
				},
			})
		}),
	)
}

// ---------------------------------------------------------------------------
// Signed-in customer: their bookings
// ---------------------------------------------------------------------------

reservationsPublicRoutes.get(
	'/mine',
	guarded(async (c) => {
		const g = await gate(c, 'manage', {
			name: 'mine',
			max: 60,
			windowMs: MINUTE,
		})
		if (!g.ok) return g.response
		if (!getBearerToken(c.req.header('Authorization'))) {
			return json({ error: 'unauthorized' }, 401)
		}
		const customer = await optionalCustomer(c, g.value.org)
		if ('error' in customer) return customer.error
		if (!customer.customerId) return json({ error: 'unauthorized' }, 401)

		const db = await getTenantDb(g.value.org.id)
		const now = Date.now()
		const { upcoming, past } = await listCustomerReservations(
			db,
			customer.customerId,
			now,
		)
		const present = (rows: typeof upcoming) =>
			rows.map((row) => ({
				...summarizeReservation(row, g.value.context),
				manageToken: deriveManageToken(
					g.value.org.id,
					row.id,
					row.manageTokenVersion,
				),
			}))
		return json({
			now: isoNow(now),
			upcoming: present(upcoming),
			past: present(past),
		})
	}),
)

registerPublicWaitlistRoutes(reservationsPublicRoutes, {
	gate,
	guarded,
	methodNotAllowed,
	optionalCustomer,
	readLocale,
	missingIdempotencyKey,
})

// Mutation paths answer every other method with a non-2xx and never run.
for (const path of [
	'/',
	'/holds',
	'/holds/release',
	'/requests',
	'/manage/modify',
	'/manage/cancel',
	'/manage/confirm',
	'/manage/late',
	'/manage/running-late',
]) {
	reservationsPublicRoutes.all(path, async (c) => methodNotAllowed(c))
}
