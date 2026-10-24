import {
	operatorAddWaitlistEntrySchema as createBodySchema,
	operatorNotifyWaitlistEntrySchema as notifyBodySchema,
	operatorReorderWaitlistSchema as reorderBodySchema,
	operatorWaitlistListQuerySchema as listQuerySchema,
	operatorSeatWaitlistEntrySchema as seatBodySchema,
	operatorUpdateWaitlistEntrySchema as updateBodySchema,
	operatorWaitlistQuoteQuerySchema as quoteQuerySchema,
	operatorWaitlistStatusSchema as statusBodySchema,
	RESERVATIONS_PERMISSIONS,
} from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import {
	handleRouteError,
	json,
	readJsonBody,
	readQuery,
	validationResponse,
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
import { resolveBusinessDate } from '../services/rsv-business-date.ts'
import {
	createWaitlistEntry,
	getOperatorWaitlistQuote,
	getSerializedEntry,
	listWaitlistEntries,
	loadWaitlistEntry,
	notifyWaitlistEntry,
	reorderWaitlist,
	seatWaitlistEntry,
	setWaitlistEntryStatus,
	updateWaitlistEntry,
} from '../services/rsv-waitlist-service.ts'

/** Action routes may be called with no body at all. */
async function readActionBody<S extends z.ZodTypeAny>(c: Context, schema: S) {
	const text = await c.req.text()
	if (!text.trim()) {
		const parsed = schema.safeParse({})
		if (!parsed.success) return { error: validationResponse(parsed.error) }
		return { data: parsed.data as z.infer<S> }
	}
	return readJsonBody(c, schema)
}

function idempotencyKeyFor(
	header: string | undefined,
	body: string | undefined,
): string {
	return header?.trim() || body?.trim() || crypto.randomUUID()
}

function canReadGuest(ctx: ReservationsAuthContext) {
	return hasReservationsGrant(
		ctx,
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	)
}

/**
 * Entry routes carry no trustworthy location: the row names it, and the caller
 * must be allowed there. A missing entry and a forbidden one answer alike only
 * when the token has no location limit; a limited token gets the location check.
 */
async function loadEntryFor(
	ctx: ReservationsAuthContext,
	entryId: string,
	claimedLocationId?: string,
) {
	if (claimedLocationId) {
		const claimed = requireReservationsLocation(ctx, claimedLocationId)
		if (!claimed.ok) return { response: claimed.response }
	}
	let entry
	try {
		entry = await loadWaitlistEntry(ctx.orgId, entryId)
	} catch (error) {
		return { response: handleRouteError(error) }
	}
	const check = requireReservationsLocation(ctx, entry.locationId)
	if (!check.ok) return { response: check.response }
	return { entry }
}

export const operatorReservationsWaitlistRoutes = new Hono()

/** Hono is strict about a trailing slash; the contract uses both forms. */
const entryIdOf = (c: Context) => c.req.param('id') ?? ''
const both = (path: string) => [path, `${path}/`]

const READ = {
	scope: 'book',
	feature: 'waitlist',
	grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
} as const

const WRITE = {
	scope: 'book',
	feature: 'waitlist',
	write: true,
	grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
} as const

operatorReservationsWaitlistRoutes.get('/', rsvGuard(READ), async (c) => {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr
	const query = readQuery(c, listQuerySchema)
	if ('error' in query) return query.error
	const loc = requireReservationsLocation(ctx, query.data.locationId)
	if (!loc.ok) return loc.response
	try {
		const db = await getTenantDb(ctx.orgId)
		const businessDate = await resolveBusinessDate(
			ctx.orgId,
			loc.locationId,
			query.data.date ?? query.data.businessDate,
		)
		const listing = await listWaitlistEntries(db, {
			locationId: loc.locationId,
			businessDate,
			canReadGuestSensitive: canReadGuest(ctx),
		})
		return json({ ok: true, orgId: ctx.orgId, ...listing })
	} catch (error) {
		return handleRouteError(error)
	}
})

operatorReservationsWaitlistRoutes.on(
	'GET',
	both('/quote'),
	rsvGuard(READ),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const query = readQuery(c, quoteQuerySchema)
		if ('error' in query) return query.error
		const loc = requireReservationsLocation(ctx, query.data.locationId)
		if (!loc.ok) return loc.response
		try {
			const db = await getTenantDb(ctx.orgId)
			const quote = await getOperatorWaitlistQuote(db, {
				locationId: loc.locationId,
				partySize: query.data.partySize,
				areaId: query.data.areaId ?? query.data.areaPrefId ?? null,
			})
			return json({ ok: true, orgId: ctx.orgId, ...quote })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

const STATION_WAITLIST_FIELDS = new Set([
	'locationId',
	'displayName',
	'partySize',
	'phone',
	'idempotencyKey',
])

operatorReservationsWaitlistRoutes.post('/', rsvGuard(WRITE), async (c) => {
	const ctx = getRsvAuth(c)
	const orgErr = await ensureActiveOrgInNodeRegion(ctx)
	if (orgErr) return orgErr
	const parsed = await readJsonBody(c, createBodySchema)
	if ('error' in parsed) return parsed.error
	// A till puts a name, a party size and a number on the list, nothing more:
	// an email (looked up and written to when seated) or a note is the app's.
	if (
		ctx.channel === 'station' &&
		Object.entries(parsed.data).some(
			([key, value]) =>
				value !== undefined &&
				value !== null &&
				!STATION_WAITLIST_FIELDS.has(key),
		)
	)
		return json(
			{
				error: 'not_for_station',
				message: 'That is done in the app, not at a till.',
			},
			403,
		)
	const loc = requireReservationsLocation(ctx, parsed.data.locationId)
	if (!loc.ok) return loc.response
	try {
		const { entryId } = await createWaitlistEntry({
			orgId: ctx.orgId,
			locationId: loc.locationId,
			idempotencyKey: idempotencyKeyFor(
				c.req.header('Idempotency-Key'),
				parsed.data.idempotencyKey,
			),
			channel: 'walk_in',
			duplicateCode: 'duplicate_active_entry',
			input: {
				displayName: parsed.data.displayName,
				partySize: parsed.data.partySize,
				phone: parsed.data.phone,
				email: parsed.data.email,
				smsOptIn: parsed.data.smsOptIn,
				areaPrefId: parsed.data.areaPrefId ?? parsed.data.areaId ?? null,
				notes: parsed.data.notes,
				locale: parsed.data.locale,
			},
		})
		const db = await getTenantDb(ctx.orgId)
		const entry = await getSerializedEntry(db, entryId, canReadGuest(ctx))
		return json({ ok: true, orgId: ctx.orgId, entry }, 201)
	} catch (error) {
		return handleRouteError(error)
	}
})

operatorReservationsWaitlistRoutes.on(
	'POST',
	both('/reorder'),
	rsvGuard(WRITE),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const parsed = await readJsonBody(c, reorderBodySchema)
		if ('error' in parsed) return parsed.error
		const loc = requireReservationsLocation(ctx, parsed.data.locationId)
		if (!loc.ok) return loc.response
		try {
			const businessDate = await resolveBusinessDate(
				ctx.orgId,
				loc.locationId,
				parsed.data.date ?? parsed.data.businessDate,
			)
			await reorderWaitlist({
				orgId: ctx.orgId,
				locationId: loc.locationId,
				businessDate,
				ids: parsed.data.ids,
			})
			const db = await getTenantDb(ctx.orgId)
			const listing = await listWaitlistEntries(db, {
				locationId: loc.locationId,
				businessDate,
				canReadGuestSensitive: canReadGuest(ctx),
			})
			return json({ ok: true, orgId: ctx.orgId, ...listing })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsWaitlistRoutes.on(
	'PATCH',
	both('/:id'),
	rsvGuard(WRITE),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const parsed = await readJsonBody(c, updateBodySchema)
		if ('error' in parsed) return parsed.error
		// Notes and contact details are hidden without the guest grant: whoever
		// cannot read them cannot overwrite them either.
		if (
			!canReadGuest(ctx) &&
			(parsed.data.notes !== undefined ||
				parsed.data.phone !== undefined ||
				parsed.data.email !== undefined)
		)
			return json(
				{
					error: 'guest_permission_required',
					message: 'Only someone who can see guest details can change them.',
				},
				403,
			)
		const loaded = await loadEntryFor(ctx, entryIdOf(c), parsed.data.locationId)
		if ('response' in loaded) return loaded.response
		try {
			const { locationId: ignoredLocationId, areaId, ...rest } = parsed.data
			await updateWaitlistEntry({
				orgId: ctx.orgId,
				entry: loaded.entry,
				input: {
					...rest,
					areaPrefId: rest.areaPrefId === undefined ? areaId : rest.areaPrefId,
				},
			})
			const db = await getTenantDb(ctx.orgId)
			const entry = await getSerializedEntry(
				db,
				loaded.entry.id,
				canReadGuest(ctx),
			)
			return json({ ok: true, orgId: ctx.orgId, entry })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsWaitlistRoutes.on(
	'POST',
	both('/:id/notify'),
	rsvGuard(WRITE),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const parsed = await readActionBody(c, notifyBodySchema)
		if ('error' in parsed) return parsed.error
		const loaded = await loadEntryFor(ctx, entryIdOf(c), parsed.data.locationId)
		if ('response' in loaded) return loaded.response
		try {
			const out = await notifyWaitlistEntry({
				orgId: ctx.orgId,
				entry: loaded.entry,
				expectedVersion: parsed.data.expectedVersion,
			})
			const db = await getTenantDb(ctx.orgId)
			const entry = await getSerializedEntry(
				db,
				loaded.entry.id,
				canReadGuest(ctx),
			)
			return json({ ok: true, orgId: ctx.orgId, changed: out.changed, entry })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsWaitlistRoutes.on(
	'POST',
	both('/:id/status'),
	rsvGuard(WRITE),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const parsed = await readJsonBody(c, statusBodySchema)
		if ('error' in parsed) return parsed.error
		const loaded = await loadEntryFor(ctx, entryIdOf(c), parsed.data.locationId)
		if ('response' in loaded) return loaded.response
		try {
			const out = await setWaitlistEntryStatus({
				orgId: ctx.orgId,
				entry: loaded.entry,
				status: parsed.data.status,
				expectedVersion: parsed.data.expectedVersion,
			})
			const db = await getTenantDb(ctx.orgId)
			const entry = await getSerializedEntry(
				db,
				loaded.entry.id,
				canReadGuest(ctx),
			)
			return json({ ok: true, orgId: ctx.orgId, changed: out.changed, entry })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

operatorReservationsWaitlistRoutes.on(
	'POST',
	both('/:id/seat'),
	rsvGuard(WRITE),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr
		const parsed = await readActionBody(c, seatBodySchema)
		if ('error' in parsed) return parsed.error
		// A till seats the party (overbooking with a reason, as the host
		// insists); swapping or moving someone else's table stays with the app.
		if (
			ctx.channel === 'station' &&
			((parsed.data.resolution !== undefined &&
				parsed.data.resolution !== 'overbook') ||
				parsed.data.moveToTableIds !== undefined)
		)
			return json(
				{
					error: 'not_for_station',
					message: 'Moving or swapping another party is done in the app.',
				},
				403,
			)
		const loaded = await loadEntryFor(ctx, entryIdOf(c), parsed.data.locationId)
		if ('response' in loaded) return loaded.response
		try {
			const seated = await seatWaitlistEntry({
				orgId: ctx.orgId,
				actorId: ctx.userId,
				entry: loaded.entry,
				idempotencyKey:
					c.req.header('Idempotency-Key')?.trim() ||
					parsed.data.idempotencyKey ||
					null,
				input: parsed.data,
				canReadGuest: canReadGuest(ctx),
			})
			const db = await getTenantDb(ctx.orgId)
			const entry = await getSerializedEntry(
				db,
				loaded.entry.id,
				canReadGuest(ctx),
			)
			return json({
				ok: true,
				orgId: ctx.orgId,
				entry,
				reservation: seated.reservation,
				moves: seated.moves,
			})
		} catch (error) {
			return handleRouteError(error)
		}
	},
)
