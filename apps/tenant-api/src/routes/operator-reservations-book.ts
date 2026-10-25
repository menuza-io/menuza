import {
	RESERVATIONS_PERMISSIONS,
	TILL_UNDO_WINDOW_MS,
} from '@repo/reservations'
import { getTenantDb, rsvReservations } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import {
	badRequest,
	ECHOING_CODES,
	handleRouteError,
	json,
} from '../lib/http.ts'
import {
	hasReservationsGrant,
	requireReservationsLocation,
	type ReservationsAuthContext,
} from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import { loadLocaleOrg } from '../lib/reservations-i18n.ts'
import {
	assignReservationTables,
	createOperatorReservation,
	createWalkIn,
	getReservationDetail,
	resendReservationConfirmation,
	transitionReservationStatus,
	tillUndoable,
	undoReservationTransition,
	updateReservation,
	updateReservationContactStatus,
	updateReservationCourseStatus,
	updateReservationNotes,
	updateReservationRunningLate,
} from '../services/rsv-booking-service.js'
import { resolveBusinessDate } from '../services/rsv-business-date.js'
import {
	getBookConflicts,
	getDayChanges,
	getDayFeed,
	getMonthCalendarSummary,
	getOperatorAvailability,
	getPreServiceOverview,
	getReservationEvents,
	getSectionAssignments,
	getServiceNotes,
	matchesDayFeedEtag,
	putSectionAssignments,
	upsertServiceNotes,
} from '../services/rsv-day-feed-service.js'
import { getGuestSummary, searchGuests } from '../services/rsv-guest-service.js'
import { getBookingsToday } from '../services/rsv-today-service.ts'
import {
	approveReservationRequest,
	declineReservationRequest,
} from '../services/rsv-request-service.js'

/** Guest allergy notes and sensitive tags need the guest-data grant. */
function canReadGuests(ctx: ReservationsAuthContext): boolean {
	return hasReservationsGrant(
		ctx,
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	)
}

const GUEST_LOOKUP_MIN_QUERY = 2

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

function resolveLocation(
	ctx: ReservationsAuthContext,
	locationId: string | undefined | null,
): { ok: true; locationId: string } | { ok: false; response: Response } {
	const check = requireReservationsLocation(ctx, locationId ?? undefined)
	if (!check.ok) return check
	return { ok: true, locationId: check.locationId }
}

async function resolveReservationLocation(
	ctx: ReservationsAuthContext,
	reservationId: string,
	fallbackLocationId?: string | null,
): Promise<
	{ ok: true; locationId: string } | { ok: false; response: Response }
> {
	const db = await getTenantDb(ctx.orgId)
	const row = await db
		.select({ id: rsvReservations.id, locationId: rsvReservations.locationId })
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()

	if (!row) {
		if (fallbackLocationId) {
			const fallbackCheck = requireReservationsLocation(ctx, fallbackLocationId)
			if (!fallbackCheck.ok) return fallbackCheck
		}
		return {
			ok: false,
			response: json(
				{ error: 'not_found', message: 'Reservation not found' },
				404,
			),
		}
	}

	const check = requireReservationsLocation(ctx, row.locationId)
	if (!check.ok) return check
	return { ok: true, locationId: row.locationId }
}

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

export const operatorReservationsBookRoutes = new Hono()

// ============================================================================
// 1. Day feed, ETag, changes polling, calendar, pre-service overview, notes
// ============================================================================

const dayQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
	areaId: z.string().trim().min(1).max(128).optional(),
	source: z.string().trim().min(1).max(128).optional(),
	tag: z.string().trim().min(1).max(128).optional(),
})

/**
 * Marks each recent no-show and finished party with whether this till may undo
 * it, and keys the ETag to the answer: it depends on who is asking.
 */
function withTillUndo<
	T extends {
		etag: string
		shortEtag: string
		reservations: Array<{ id: string }>
	},
>(feed: T, undo: { candidates: Set<string>; allowed: Set<string> }): T {
	if (undo.candidates.size === 0) return feed
	const allowed = [...undo.allowed].sort().join(',')
	let hash = 0
	for (let i = 0; i < allowed.length; i++)
		hash = (Math.imul(hash, 31) + allowed.charCodeAt(i)) | 0
	const tag = (etag: string) =>
		etag.replace(/"$/, `:u${(hash >>> 0).toString(36)}"`)
	return {
		...feed,
		etag: tag(feed.etag),
		shortEtag: tag(feed.shortEtag),
		reservations: feed.reservations.map((r) =>
			undo.candidates.has(r.id) ? { ...r, canUndo: undo.allowed.has(r.id) } : r,
		),
	}
}

operatorReservationsBookRoutes.get(
	'/day',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, dayQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const businessDate = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)

		try {
			const db = await getTenantDb(ctx.orgId)
			const canReadGuestSensitive = hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			)
			const day = await getDayFeed(db, locCheck.locationId, businessDate, {
				canReadGuestSensitive,
				filters: {
					serviceId: q.data.serviceId,
					areaId: q.data.areaId,
					source: q.data.source,
					tag: q.data.tag,
				},
			})
			// A till is told which recent no-shows and cleared parties it may undo
			// (its person's or the system's), so it never offers one it would be refused.
			const feed =
				ctx.channel === 'station'
					? withTillUndo(
							day,
							await tillUndoable(db, day.reservations, ctx.userId, Date.now()),
						)
					: day

			const ifNoneMatch = c.req.header('If-None-Match')
			if (matchesDayFeedEtag(ifNoneMatch, feed.etag, feed.shortEtag)) {
				return new Response(null, {
					status: 304,
					headers: {
						ETag: feed.etag,
						'Cache-Control': 'private, no-cache',
					},
				})
			}

			return new Response(
				JSON.stringify({
					ok: true,
					orgId: ctx.orgId,
					...feed,
				}),
				{
					status: 200,
					headers: {
						'Content-Type': 'application/json; charset=utf-8',
						ETag: feed.etag,
						'Cache-Control': 'private, no-cache',
					},
				},
			)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const changesQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	since: z.coerce.number().int().min(0).optional(),
	sinceVersion: z.coerce.number().int().min(0).optional(),
	dayVersion: z.coerce.number().int().min(0).optional(),
})

const todayQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
})

operatorReservationsBookRoutes.get(
	'/today',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, todayQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		try {
			const db = await getTenantDb(ctx.orgId)
			const now = Date.now()
			const businessDate = await resolveBusinessDate(
				ctx.orgId,
				locCheck.locationId,
			)
			const today = await getBookingsToday(db, {
				locationId: locCheck.locationId,
				businessDate,
				now,
			})
			c.header('Cache-Control', 'private, no-store')
			return json({ ok: true, orgId: ctx.orgId, ...today })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsBookRoutes.get(
	'/changes',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, changesQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const businessDate = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)
		const sinceVersion =
			q.data.since ?? q.data.sinceVersion ?? q.data.dayVersion ?? 0

		try {
			const db = await getTenantDb(ctx.orgId)
			const changes = await getDayChanges(
				db,
				locCheck.locationId,
				businessDate,
				sinceVersion,
			)
			return json({ ok: true, orgId: ctx.orgId, ...changes })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const conflictsQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
})

operatorReservationsBookRoutes.get(
	'/conflicts',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, conflictsQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const businessDate = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)

		try {
			const db = await getTenantDb(ctx.orgId)
			const canReadGuestSensitive = hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			)
			const conflicts = await getBookConflicts(
				db,
				locCheck.locationId,
				businessDate,
				{
					canReadGuestSensitive,
				},
			)
			return json({ ok: true, orgId: ctx.orgId, ...conflicts })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const availabilityQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	partySize: z.coerce.number().int().min(1).max(99).optional().default(2),
	serviceId: z.string().trim().min(1).max(128).optional(),
	areaId: z.string().trim().min(1).max(128).optional(),
	diningAreaId: z.string().trim().min(1).max(128).optional(),
	durationMin: z.coerce.number().int().min(15).max(720).optional(),
	/** Times for changing this booking: its own tables and covers are free. */
	excludeReservationId: z.string().trim().min(1).max(128).optional(),
})

operatorReservationsBookRoutes.get(
	'/availability',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, availabilityQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const date = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)

		try {
			const db = await getTenantDb(ctx.orgId)
			const availability = await getOperatorAvailability(db, {
				locationId: locCheck.locationId,
				date,
				partySize: q.data.partySize,
				serviceId: q.data.serviceId ?? null,
				areaId: q.data.areaId ?? q.data.diningAreaId ?? null,
				durationMin: q.data.durationMin ?? null,
				excludeReservationId: q.data.excludeReservationId ?? null,
			})
			return json({ ok: true, orgId: ctx.orgId, ...availability })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const calendarQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	month: z.string().regex(MONTH_RE).optional(),
	date: z.string().regex(DATE_RE).optional(),
})

operatorReservationsBookRoutes.get(
	'/calendar',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, calendarQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const month =
			q.data.month ??
			(q.data.date ? q.data.date.slice(0, 7) : undefined) ??
			new Date().toISOString().slice(0, 7)

		try {
			const db = await getTenantDb(ctx.orgId)
			const summary = await getMonthCalendarSummary(
				db,
				locCheck.locationId,
				month,
			)
			return json({ ok: true, orgId: ctx.orgId, ...summary })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const overviewQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
})

operatorReservationsBookRoutes.get(
	'/overview',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, overviewQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const date = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)

		try {
			const db = await getTenantDb(ctx.orgId)
			const canReadGuestSensitive = hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			)
			const overview = await getPreServiceOverview(
				db,
				locCheck.locationId,
				date,
				{
					serviceId: q.data.serviceId ?? null,
					canReadGuestSensitive,
				},
			)
			return json({ ok: true, orgId: ctx.orgId, ...overview })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const serviceNotesQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
})

operatorReservationsBookRoutes.get(
	'/service-notes',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, serviceNotesQuerySchema)
		if ('error' in q) return q.error

		const locCheck = resolveLocation(ctx, q.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const date = await resolveBusinessDate(
			ctx.orgId,
			locCheck.locationId,
			q.data.date ?? q.data.businessDate,
		)

		try {
			const db = await getTenantDb(ctx.orgId)
			const res = await getServiceNotes(
				db,
				locCheck.locationId,
				date,
				q.data.serviceId ?? null,
			)
			return json({ ok: true, orgId: ctx.orgId, ...res })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const upsertServiceNotesSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().max(128).optional().nullable(),
	notes: z.string().max(4000).optional(),
	note: z.string().max(4000).optional(),
	body: z.string().max(4000).optional(),
	text: z.string().max(4000).optional(),
	expectedVersion: z.number().int().min(0).optional(),
})

async function handleUpsertServiceNotes(c: Context) {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr

	const parsed = await parseBody(c, upsertServiceNotesSchema)
	if ('error' in parsed) return parsed.error

	const locationId = parsed.data.locationId ?? c.req.query('locationId')?.trim()
	if (!locationId) {
		return handleRouteError(
			badRequest('missing_location_id', 'locationId is required'),
		)
	}
	const locCheck = resolveLocation(ctx, locationId)
	if (!locCheck.ok) return locCheck.response

	const businessDate = await resolveBusinessDate(
		ctx.orgId,
		locCheck.locationId,
		parsed.data.date ?? parsed.data.businessDate ?? c.req.query('date')?.trim(),
	)
	const noteText =
		parsed.data.notes ??
		parsed.data.note ??
		parsed.data.body ??
		parsed.data.text ??
		''

	try {
		const db = await getTenantDb(ctx.orgId)
		const saved = await upsertServiceNotes(db, {
			locationId: locCheck.locationId,
			businessDate,
			serviceId: parsed.data.serviceId ?? null,
			note: noteText,
			actorId: ctx.userId,
			expectedVersion: parsed.data.expectedVersion,
		})
		return json({
			ok: true,
			orgId: ctx.orgId,
			note: saved,
			serviceNote: saved,
		})
	} catch (error) {
		return handleRouteError(error)
	}
}

operatorReservationsBookRoutes.put(
	'/service-notes',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpsertServiceNotes,
)

operatorReservationsBookRoutes.post(
	'/service-notes',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpsertServiceNotes,
)

// ============================================================================
// 2. Per-service server section assignments
// ============================================================================

const sectionAssignmentsQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
})

async function handleGetSectionAssignments(c: Context) {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr

	const q = parseQuery(c, sectionAssignmentsQuerySchema)
	if ('error' in q) return q.error

	const locCheck = resolveLocation(ctx, q.data.locationId)
	if (!locCheck.ok) return locCheck.response

	const date = await resolveBusinessDate(
		ctx.orgId,
		locCheck.locationId,
		q.data.date ?? q.data.businessDate,
	)

	try {
		const db = await getTenantDb(ctx.orgId)
		const res = await getSectionAssignments(
			db,
			locCheck.locationId,
			date,
			q.data.serviceId ?? null,
		)
		return json({ ok: true, orgId: ctx.orgId, ...res })
	} catch (error) {
		return handleRouteError(error)
	}
}

operatorReservationsBookRoutes.get(
	'/section-assignments',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	handleGetSectionAssignments,
)

operatorReservationsBookRoutes.get(
	'/sections/assignments',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	handleGetSectionAssignments,
)

const sectionAssignmentItemSchema = z.object({
	sectionId: z.string().trim().min(1).max(128).optional(),
	layoutId: z.string().trim().min(1).max(128).optional(),
	staffId: z.string().trim().max(128).optional().nullable(),
	serverLabel: z.string().trim().max(120).optional().nullable(),
	color: z.string().trim().max(40).optional().nullable(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
})

const putSectionAssignmentsSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	serviceId: z.string().trim().min(1).max(128).optional(),
	assignments: z.array(sectionAssignmentItemSchema).optional(),
	sectionId: z.string().trim().min(1).max(128).optional(),
	layoutId: z.string().trim().min(1).max(128).optional(),
	staffId: z.string().trim().max(128).optional().nullable(),
	serverLabel: z.string().trim().max(120).optional().nullable(),
	color: z.string().trim().max(40).optional().nullable(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
})

async function handlePutSectionAssignments(c: Context) {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr

	const parsed = await parseBody(c, putSectionAssignmentsSchema)
	if ('error' in parsed) return parsed.error

	const locationId = parsed.data.locationId ?? c.req.query('locationId')?.trim()
	if (!locationId) {
		return handleRouteError(
			badRequest('missing_location_id', 'locationId is required'),
		)
	}
	const locCheck = resolveLocation(ctx, locationId)
	if (!locCheck.ok) return locCheck.response

	const businessDate = await resolveBusinessDate(
		ctx.orgId,
		locCheck.locationId,
		parsed.data.date ?? parsed.data.businessDate ?? c.req.query('date')?.trim(),
	)
	const serviceId =
		parsed.data.serviceId ?? c.req.query('serviceId')?.trim() ?? 'default'

	const items =
		parsed.data.assignments ??
		(parsed.data.sectionId || parsed.data.layoutId
			? [
					{
						sectionId: (parsed.data.sectionId ?? parsed.data.layoutId)!,
						staffId: parsed.data.staffId ?? null,
						serverLabel: parsed.data.serverLabel ?? null,
						color: parsed.data.color ?? null,
						tableIds: parsed.data.tableIds,
					},
				]
			: [])

	try {
		const db = await getTenantDb(ctx.orgId)
		const res = await putSectionAssignments(db, {
			locationId: locCheck.locationId,
			businessDate,
			serviceId,
			actorId: ctx.userId,
			assignments: items.map((item) => ({
				sectionId: (item.sectionId ?? item.layoutId)!,
				staffId: item.staffId ?? null,
				serverLabel: item.serverLabel ?? null,
				color: item.color ?? null,
				tableIds: item.tableIds,
			})),
		})
		return json({ ok: true, orgId: ctx.orgId, ...res })
	} catch (error) {
		return handleRouteError(error)
	}
}

operatorReservationsBookRoutes.put(
	'/section-assignments',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handlePutSectionAssignments,
)

operatorReservationsBookRoutes.put(
	'/sections/assignments',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handlePutSectionAssignments,
)

// ============================================================================
// 3. Guest lookup / quick-create under /book/guests/* (book scope convenience)
// ============================================================================

const guestLookupQuerySchema = z.object({
	q: z.string().trim().max(120).optional().default(''),
	limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

operatorReservationsBookRoutes.get(
	'/guests/lookup',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const q = parseQuery(c, guestLookupQuerySchema)
		if ('error' in q) return q.error

		try {
			if (q.data.q.length < GUEST_LOOKUP_MIN_QUERY) {
				throw badRequest(
					'query_too_short',
					`q must be at least ${GUEST_LOOKUP_MIN_QUERY} characters`,
				)
			}
			const db = await getTenantDb(ctx.orgId)
			const guests = await searchGuests(db, q.data.q, {
				limit: q.data.limit,
				canReadSensitive: canReadGuests(ctx),
			})
			return json({ ok: true, orgId: ctx.orgId, guests })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsBookRoutes.get(
	'/guests/:id/summary',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		try {
			const db = await getTenantDb(ctx.orgId)
			const canReadSensitive = hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			)
			const summary = await getGuestSummary(db, c.req.param('id'), {
				canReadSensitive,
			})
			return json({ ok: true, orgId: ctx.orgId, ...summary })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

// ============================================================================
// 4. Create reservation, create walk-in, and reservation mutations
// ============================================================================

/**
 * What a till sends when it books or seats a walk-in (apps/station
 * src/apps/reservations/api.ts): no overbooking a future booking, no locks,
 * no other channel, no attaching an existing guest profile, no health notes.
 */
const STATION_BOOKING_FIELDS = new Set([
	'locationId',
	'date',
	'businessDate',
	'time',
	'slotLocal',
	'localStartMin',
	'partySize',
	'channel',
	'guest',
	'staffNotes',
	'tableIds',
])
// A walk-in is seated now (the server's clock and business day) and named by
// the host; it never looks a guest up by phone or email, which a till without
// guest details could otherwise use to learn whose number it is.
const STATION_WALK_IN_FIELDS = new Set([
	'locationId',
	'partySize',
	'tableIds',
	'guestName',
	// "Seat anyway": the host's call on a table someone is due at, recorded.
	'overbook',
	'overbookReason',
])
/**
 * A guest typed in at a till: a name and a phone number, nothing more. The
 * host stand never asks for an email address, and a till without guest
 * details may not use one to find out whose it is.
 */
const STATION_GUEST_FIELDS = new Set(['firstName', 'lastName', 'phone'])

const stationRefusal = () =>
	json(
		{
			error: 'not_for_station',
			message: 'That is done in the app, not at a till.',
		},
		403,
	)

/** Refuses a till's request that carries fields its host stand never sends. */
function stationBodyDenied(
	data: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): Response | null {
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue
		if (!allowed.has(key)) return stationRefusal()
	}
	const guest = data.guest
	if (guest && typeof guest === 'object')
		for (const [key, value] of Object.entries(guest)) {
			if (value === undefined) continue
			if (!STATION_GUEST_FIELDS.has(key)) return stationRefusal()
		}
	return null
}

const guestInlineSchema = z.object({
	id: z.string().trim().min(1).max(128).optional(),
	firstName: z.string().trim().min(1).max(120),
	lastName: z.string().trim().max(120).optional().default(''),
	phone: z.string().trim().max(32).optional().nullable(),
	phoneE164: z.string().trim().max(32).optional().nullable(),
	email: z.string().trim().email().max(255).optional().nullable(),
	emailNorm: z.string().trim().email().max(255).optional().nullable(),
	locale: z.string().trim().max(16).optional(),
	smsOptIn: z.boolean().optional(),
	allergyNotes: z.string().max(1000).optional().nullable(),
})

/**
 * A new guest typed in by staff speaks the organization's default language
 * until they choose another one; an existing guest keeps their own.
 */
async function withDefaultGuestLocale<
	G extends { id?: string | null; locale?: string } | null | undefined,
>(orgId: string, guest: G): Promise<G> {
	if (!guest || guest.id || guest.locale) return guest
	const org = await loadLocaleOrg(orgId)
	return org ? { ...guest, locale: org.defaultLocale } : guest
}

const createBookingBodySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	time: z.string().regex(TIME_RE).optional(),
	slotLocal: z.string().regex(TIME_RE).optional(),
	localStartMin: z.number().int().min(0).max(1800).optional(),
	partySize: z.number().int().min(1).max(99),
	durationMin: z.number().int().min(15).max(720).optional().nullable(),
	serviceId: z.string().trim().max(128).optional().nullable(),
	areaPrefId: z.string().trim().max(128).optional().nullable(),
	diningAreaId: z.string().trim().max(128).optional().nullable(),
	areaPrefStrict: z.boolean().optional(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	comboId: z.string().trim().max(128).optional().nullable(),
	lock: z.boolean().optional(),
	locked: z.boolean().optional(),
	tableLocked: z.boolean().optional(),
	lockTable: z.boolean().optional(),
	assignment: z.enum(['soft', 'locked']).optional(),
	skipPayment: z.boolean().optional(),
	paymentPolicyMode: z.string().trim().max(40).optional().nullable(),
	guestId: z.string().trim().min(1).max(128).optional(),
	guest: guestInlineSchema.optional(),
	firstName: z.string().trim().min(1).max(120).optional(),
	lastName: z.string().trim().max(120).optional(),
	phone: z.string().trim().max(32).optional().nullable(),
	phoneE164: z.string().trim().max(32).optional().nullable(),
	email: z.string().trim().email().max(255).optional().nullable(),
	occasionTagId: z.string().trim().max(128).optional().nullable(),
	occasion: z.string().trim().max(128).optional().nullable(),
	dietaryNotes: z.string().max(1000).optional().nullable(),
	guestRequests: z.string().max(1000).optional().nullable(),
	staffNotes: z.string().max(2000).optional().nullable(),
	internalNotes: z.string().max(2000).optional().nullable(),
	tagIds: z.array(z.string().trim().min(1)).optional(),
	sendConfirmation: z.boolean().optional(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
	channel: z.enum(['host', 'phone', 'online', 'walk_in']).optional(),
	source: z.enum(['host', 'phone', 'online', 'walk_in']).optional(),
	idempotencyKey: z.string().trim().min(1).max(128).optional(),
})

operatorReservationsBookRoutes.post(
	'/reservations',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, createBookingBodySchema)
		if ('error' in parsed) return parsed.error
		if (ctx.channel === 'station') {
			const denied = stationBodyDenied(parsed.data, STATION_BOOKING_FIELDS)
			if (denied) return denied
			if (parsed.data.channel !== undefined && parsed.data.channel !== 'host')
				return stationRefusal()
		}

		const locCheck = resolveLocation(ctx, parsed.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const idempotencyKey =
			c.req.header('Idempotency-Key')?.trim() ||
			parsed.data.idempotencyKey?.trim() ||
			null

		try {
			const guestInput =
				parsed.data.guest ??
				(parsed.data.firstName
					? {
							firstName: parsed.data.firstName,
							lastName: parsed.data.lastName ?? '',
							phone: parsed.data.phone ?? parsed.data.phoneE164 ?? null,
							email: parsed.data.email ?? null,
						}
					: undefined)

			const guestWithLocale = await withDefaultGuestLocale(
				ctx.orgId,
				guestInput,
			)
			const rawChannel = parsed.data.channel ?? parsed.data.source
			const mappedChannel = rawChannel === 'host' ? 'in_person' : rawChannel

			const created = await createOperatorReservation({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				locationId: locCheck.locationId,
				actorId: ctx.userId,
				idempotencyKey: idempotencyKey ?? '',
				input: {
					...parsed.data,
					channel: mappedChannel,
					date: parsed.data.date ?? parsed.data.businessDate ?? '',
					time: parsed.data.time ?? parsed.data.slotLocal,
					locationId: locCheck.locationId,
					guest: guestWithLocale,
				},
			})

			return json(
				{
					ok: true,
					orgId: ctx.orgId,
					...created,
				},
				201,
			)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const createWalkInBodySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	time: z.string().regex(TIME_RE).optional(),
	slotLocal: z.string().regex(TIME_RE).optional(),
	localStartMin: z.number().int().min(0).max(1800).optional(),
	partySize: z.number().int().min(1).max(99),
	durationMin: z.number().int().min(15).max(720).optional().nullable(),
	serviceId: z.string().trim().max(128).optional().nullable(),
	areaId: z.string().trim().max(128).optional().nullable(),
	diningAreaId: z.string().trim().max(128).optional().nullable(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	comboId: z.string().trim().max(128).optional().nullable(),
	guestId: z.string().trim().min(1).max(128).optional().nullable(),
	guest: guestInlineSchema.optional().nullable(),
	guestName: z.string().trim().max(120).optional().nullable(),
	phone: z.string().trim().max(32).optional().nullable(),
	dietaryNotes: z.string().max(1000).optional().nullable(),
	staffNotes: z.string().max(2000).optional().nullable(),
	internalNotes: z.string().max(2000).optional().nullable(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
	idempotencyKey: z.string().trim().min(1).max(128).optional(),
})

operatorReservationsBookRoutes.post(
	'/walk-ins',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, createWalkInBodySchema)
		if ('error' in parsed) return parsed.error
		if (ctx.channel === 'station') {
			const denied = stationBodyDenied(parsed.data, STATION_WALK_IN_FIELDS)
			if (denied) return denied
		}

		const locCheck = resolveLocation(ctx, parsed.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const idempotencyKey =
			c.req.header('Idempotency-Key')?.trim() ||
			parsed.data.idempotencyKey?.trim() ||
			null

		try {
			const created = await createWalkIn({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				locationId: locCheck.locationId,
				actorId: ctx.userId,
				idempotencyKey: idempotencyKey ?? '',
				input: {
					...parsed.data,
					// The name the host typed, when no profile came with it: a new
					// guest under that name (no phone, so it matches nobody).
					guest: await withDefaultGuestLocale(
						ctx.orgId,
						parsed.data.guest ??
							(parsed.data.guestName?.trim()
								? { firstName: parsed.data.guestName.trim(), lastName: '' }
								: undefined),
					),
					date: parsed.data.date ?? parsed.data.businessDate,
					time: parsed.data.time ?? parsed.data.slotLocal,
					locationId: locCheck.locationId,
				},
			})

			return json(
				{
					ok: true,
					orgId: ctx.orgId,
					...created,
				},
				201,
			)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsBookRoutes.get(
	'/reservations/:id',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const db = await getTenantDb(ctx.orgId)
			const detail = await getReservationDetail(db, rsvId, detailAccess(ctx))
			return json({ ok: true, orgId: ctx.orgId, ...detail })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

/**
 * Allergy and dietary notes are health details: someone who cannot read them
 * (a host at a till without guest details, a member without the guest
 * permission) cannot overwrite or clear them either.
 */
function healthNotesDenied(
	ctx: ReservationsAuthContext,
	input: { dietaryNotes?: unknown; guestRequests?: unknown },
): Response | null {
	// The guest's own request text is hidden the same way ("son has a peanut allergy").
	if (input.dietaryNotes === undefined && input.guestRequests === undefined)
		return null
	if (canReadGuests(ctx)) return null
	return json(
		{
			error: 'guest_permission_required',
			message: 'Only someone who can see allergy notes can change them.',
		},
		403,
	)
}

/** What a reservation's detail may include for this caller. */
function detailAccess(ctx: ReservationsAuthContext) {
	const canReadGuestSensitive = hasReservationsGrant(
		ctx,
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	)
	return {
		canReadGuestSensitive,
		// Card details stay off a shared till unless its token holds the payment grant.
		canReadPayments:
			ctx.channel !== 'station' ||
			hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
			),
		// A till without guest details never reaches the guestbook, here included.
		guestHistory: ctx.channel !== 'station' || canReadGuestSensitive,
	}
}

operatorReservationsBookRoutes.get(
	'/reservations/:id/events',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const db = await getTenantDb(ctx.orgId)
			const res = await getReservationEvents(db, rsvId, {
				canReadGuestSensitive: hasReservationsGrant(
					ctx,
					RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
				),
			})
			return json({ ok: true, orgId: ctx.orgId, ...res })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

/** What a till may change on a booking: its size and when. */
const STATION_PATCH_FIELDS = new Set([
	'locationId',
	'expectedVersion',
	'date',
	'businessDate',
	'time',
	'slotLocal',
	'localStartMin',
	'partySize',
])

const patchReservationSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	expectedVersion: z.number().int().min(1).optional(),
	date: z.string().regex(DATE_RE).optional(),
	businessDate: z.string().regex(DATE_RE).optional(),
	time: z.string().regex(TIME_RE).optional(),
	slotLocal: z.string().regex(TIME_RE).optional(),
	localStartMin: z.number().int().min(0).max(1800).optional(),
	partySize: z.number().int().min(1).max(99).optional(),
	durationMin: z.number().int().min(15).max(720).optional(),
	areaPrefId: z.string().trim().max(128).optional().nullable(),
	diningAreaId: z.string().trim().max(128).optional().nullable(),
	areaPrefStrict: z.boolean().optional(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	comboId: z.string().trim().max(128).optional().nullable(),
	lock: z.boolean().optional(),
	locked: z.boolean().optional(),
	lockTable: z.boolean().optional(),
	unlock: z.boolean().optional(),
	assignment: z.enum(['soft', 'locked']).optional(),
	reflowLaterParties: z.boolean().optional(),
	occasionTagId: z.string().trim().max(128).optional().nullable(),
	occasion: z.string().trim().max(128).optional().nullable(),
	dietaryNotes: z.string().max(1000).optional().nullable(),
	guestRequests: z.string().max(1000).optional().nullable(),
	staffNotes: z.string().max(2000).optional().nullable(),
	internalNotes: z.string().max(2000).optional().nullable(),
	tagIds: z.array(z.string().trim().min(1)).optional(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
})

operatorReservationsBookRoutes.patch(
	'/reservations/:id',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, patchReservationSchema)
		if ('error' in parsed) return parsed.error
		const notesDenied = healthNotesDenied(ctx, parsed.data)
		if (notesDenied) return notesDenied
		// At a till only the party's size and time move ("we're six now", "make
		// it 8"): notes, tags, tables, locks and overbooking stay with the app.
		if (ctx.channel === 'station') {
			const extra = Object.keys(parsed.data).filter(
				(key) =>
					!STATION_PATCH_FIELDS.has(key) &&
					parsed.data[key as keyof typeof parsed.data] !== undefined,
			)
			if (extra.length > 0)
				return json(
					{
						error: 'not_for_station',
						message: 'Only the party size and time change at a till.',
					},
					403,
				)
		}

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const updated = await updateReservation({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				// A till changes size and time only within what the slot takes and
				// never on a booking with money on it.
				paymentLocked:
					ctx.channel === 'station' &&
					!hasReservationsGrant(
						ctx,
						RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
					),
				input: {
					...parsed.data,
					date: parsed.data.date ?? parsed.data.businessDate,
					time: parsed.data.time ?? parsed.data.slotLocal,
				},
			})
			return json({ ok: true, orgId: ctx.orgId, ...updated })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

/** What a till may send when it puts a party on tables. */
const STATION_ASSIGN_FIELDS = new Set([
	'locationId',
	'tableIds',
	'comboId',
	'expectedVersion',
	'overbook',
	'overbookReason',
])

const assignTablesSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	comboId: z.string().trim().max(128).optional().nullable(),
	lock: z.boolean().optional(),
	locked: z.boolean().optional(),
	tableLocked: z.boolean().optional(),
	unlock: z.boolean().optional(),
	swap: z.boolean().optional(),
	assignment: z.enum(['soft', 'locked']).optional(),
	swapWithReservationId: z.string().trim().max(128).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/assign',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, assignTablesSchema)
		if ('error' in parsed) return parsed.error
		// A till puts a party on tables; locking, unlocking and swapping with
		// another party stay with the app.
		if (ctx.channel === 'station') {
			const extra = Object.keys(parsed.data).filter(
				(key) =>
					!STATION_ASSIGN_FIELDS.has(key) &&
					parsed.data[key as keyof typeof parsed.data] !== undefined,
			)
			if (extra.length > 0)
				return json(
					{
						error: 'not_for_station',
						message: 'Locking and swapping tables is done in the app.',
					},
					403,
				)
		}

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const result = await assignReservationTables({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				input: parsed.data,
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const statusTransitionSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	status: z.string().trim().min(1).optional(),
	toStatus: z.string().trim().min(1).optional(),
	expectedVersion: z.number().int().min(1).optional(),
	tableIds: z.array(z.string().trim().min(1)).optional(),
	comboId: z.string().trim().max(128).optional().nullable(),
	covers: z.number().int().min(1).max(99).optional().nullable(),
	coversActual: z.number().int().min(1).max(99).optional().nullable(),
	seatedCovers: z.number().int().min(1).max(99).optional().nullable(),
	seatedPartySize: z.number().int().min(1).max(99).optional().nullable(),
	arrivedCovers: z.number().int().min(1).max(99).optional().nullable(),
	arrivedPartySize: z.number().int().min(1).max(99).optional().nullable(),
	cancelReason: z.string().max(500).optional().nullable(),
	reason: z.string().max(500).optional().nullable(),
	overbook: z.boolean().optional(),
	overbookReason: z.string().max(500).optional().nullable(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/status',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, statusTransitionSchema)
		if ('error' in parsed) return parsed.error

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const result = await transitionReservationStatus({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				// A till's host does not touch money (deposits, refunds, no-show fees).
				paymentLocked:
					ctx.channel === 'station' &&
					!hasReservationsGrant(
						ctx,
						RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
					),
				serviceDayOnly: ctx.channel === 'station',
				input: {
					...parsed.data,
					status: parsed.data.status ?? parsed.data.toStatus ?? '',
				},
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const resendSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	rotate: z.boolean().optional(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/resend',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, resendSchema)
		if ('error' in parsed) return parsed.error

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const result = await resendReservationConfirmation({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				input: { rotate: parsed.data.rotate },
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const undoTransitionSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	expectedVersion: z.number().int().min(1).optional(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/undo',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, undoTransitionSchema)
		if ('error' in parsed) return parsed.error

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		// Undoing a cancel or a no-show brings back a booking whose payment may
		// have been settled (a refund, a released card): with money on it, that
		// is the app's call. Undoing a seating or an arrival never is.
		if (
			ctx.channel === 'station' &&
			!hasReservationsGrant(
				ctx,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
			)
		) {
			const db = await getTenantDb(ctx.orgId)
			const [row] = await db
				.select({
					status: rsvReservations.status,
					paymentStatus: rsvReservations.paymentStatus,
					policySnapshot: rsvReservations.policySnapshot,
				})
				.from(rsvReservations)
				.where(eq(rsvReservations.id, rsvId))
				.limit(1)
			const policyAmount = Number(
				(row?.policySnapshot as { totalAmountMinor?: unknown } | null)
					?.totalAmountMinor ?? 0,
			)
			if (
				row &&
				(row.status === 'cancelled' || row.status === 'no_show') &&
				(row.paymentStatus !== 'none' || policyAmount > 0)
			)
				return json(
					{
						error: 'manager_required',
						message:
							'This booking has a payment on it. A manager changes it in the app.',
					},
					409,
				)
		}

		try {
			const result = await undoReservationTransition({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				// At a till: the host's own slip, within half an hour.
				...(ctx.channel === 'station'
					? { ownRecentOnly: { withinMs: TILL_UNDO_WINDOW_MS } }
					: {}),
				input: parsed.data,
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const contactStatusSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	contactStatus: z.string().trim().max(40).optional().nullable(),
	status: z.string().trim().max(40).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
})

async function handleUpdateContactStatus(c: Context) {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr

	const parsed = await parseBody(c, contactStatusSchema)
	if ('error' in parsed) return parsed.error

	const rsvId = c.req.param('id')!
	const locCheck = await resolveReservationLocation(
		ctx,
		rsvId,
		parsed.data.locationId ?? c.req.query('locationId'),
	)
	if (!locCheck.ok) return locCheck.response

	try {
		const result = await updateReservationContactStatus({
			canReadGuestSensitive: canReadGuests(ctx),
			orgId: ctx.orgId,
			reservationId: rsvId,
			actorId: ctx.userId,
			input: {
				...parsed.data,
				contactStatus:
					parsed.data.contactStatus ?? parsed.data.status ?? 'none',
			},
		})
		return json({ ok: true, orgId: ctx.orgId, ...result })
	} catch (error) {
		return handleRouteError(error)
	}
}

operatorReservationsBookRoutes.post(
	'/reservations/:id/contact',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpdateContactStatus,
)

operatorReservationsBookRoutes.post(
	'/reservations/:id/contact-status',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpdateContactStatus,
)

const runningLateSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	runningLateMin: z.number().int().min(0).max(240).optional().nullable(),
	runningLateMinutes: z.number().int().min(0).max(240).optional().nullable(),
	minutes: z.number().int().min(0).max(240).optional().nullable(),
	note: z.string().max(500).optional().nullable(),
	runningLateNote: z.string().max(500).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/running-late',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, runningLateSchema)
		if ('error' in parsed) return parsed.error

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const result = await updateReservationRunningLate({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				input: parsed.data,
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const courseStatusSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	course: z.string().trim().max(40).optional().nullable(),
	courseStatus: z.string().trim().max(40).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
})

async function handleUpdateCourseStatus(c: Context) {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr

	const parsed = await parseBody(c, courseStatusSchema)
	if ('error' in parsed) return parsed.error

	const rsvId = c.req.param('id')!
	const locCheck = await resolveReservationLocation(
		ctx,
		rsvId,
		parsed.data.locationId ?? c.req.query('locationId'),
	)
	if (!locCheck.ok) return locCheck.response

	try {
		const result = await updateReservationCourseStatus({
			canReadGuestSensitive: canReadGuests(ctx),
			orgId: ctx.orgId,
			reservationId: rsvId,
			actorId: ctx.userId,
			input: {
				...parsed.data,
				courseStatus: parsed.data.courseStatus ?? parsed.data.course ?? null,
			},
		})
		return json({ ok: true, orgId: ctx.orgId, ...result })
	} catch (error) {
		return handleRouteError(error)
	}
}

operatorReservationsBookRoutes.post(
	'/reservations/:id/course',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpdateCourseStatus,
)

operatorReservationsBookRoutes.post(
	'/reservations/:id/course-status',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	handleUpdateCourseStatus,
)

const notesUpdateSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	dietaryNotes: z.string().max(1000).optional().nullable(),
	guestRequests: z.string().max(1000).optional().nullable(),
	staffNotes: z.string().max(2000).optional().nullable(),
	internalNotes: z.string().max(2000).optional().nullable(),
	expectedVersion: z.number().int().min(1).optional(),
})

operatorReservationsBookRoutes.post(
	'/reservations/:id/notes',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await parseBody(c, notesUpdateSchema)
		if ('error' in parsed) return parsed.error
		const notesDenied = healthNotesDenied(ctx, parsed.data)
		if (notesDenied) return notesDenied

		const rsvId = c.req.param('id')
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			const result = await updateReservationNotes({
				canReadGuestSensitive: canReadGuests(ctx),
				orgId: ctx.orgId,
				reservationId: rsvId,
				actorId: ctx.userId,
				input: parsed.data,
			})
			return json({ ok: true, orgId: ctx.orgId, ...result })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const requestDecisionSchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
	reason: z.string().trim().max(500).optional().nullable(),
})

function requestDecisionHandler(decision: 'approve' | 'decline') {
	return async (c: Context) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const raw = await c.req.json().catch(() => ({}))
		const parsed = requestDecisionSchema.safeParse(raw ?? {})
		if (!parsed.success) {
			return handleRouteError(badRequest('validation_error'))
		}

		const rsvId = c.req.param('id') ?? ''
		const locCheck = await resolveReservationLocation(
			ctx,
			rsvId,
			parsed.data.locationId ?? c.req.query('locationId'),
		)
		if (!locCheck.ok) return locCheck.response

		try {
			if (decision === 'approve') {
				await approveReservationRequest({
					orgId: ctx.orgId,
					reservationId: rsvId,
					actorId: ctx.userId,
				})
			} else {
				await declineReservationRequest({
					orgId: ctx.orgId,
					reservationId: rsvId,
					actorId: ctx.userId,
					reason: parsed.data.reason,
				})
			}
			const db = await getTenantDb(ctx.orgId)
			const detail = await getReservationDetail(db, rsvId, detailAccess(ctx))
			return json({ ok: true, orgId: ctx.orgId, ...detail })
		} catch (error) {
			return handleRouteError(error)
		}
	}
}

for (const decision of ['approve', 'decline'] as const) {
	for (const path of [
		`/reservations/:id/${decision}`,
		`/requests/:id/${decision}`,
	]) {
		operatorReservationsBookRoutes.post(
			path,
			rsvGuard({
				scope: 'book',
				write: true,
				grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			}),
			requestDecisionHandler(decision),
		)
	}
}
