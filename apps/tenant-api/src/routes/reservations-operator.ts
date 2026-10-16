import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import {
	getTenantDb,
	rsvAreas,
	rsvDayVersions,
	rsvExperiences,
	rsvGuests,
	rsvLocationSettings,
	rsvReservations,
	rsvServices,
	rsvTableCombos,
	rsvTables,
	rsvTurnTimes,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json, readJsonBody, readQuery } from '../lib/http.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	filterReservationsLocations,
	requireReservationsLocation,
	type ReservationsAuthContext,
} from '../lib/reservations-auth.ts'
import { getRsvAuth, rsvGuard } from '../lib/reservations-guard.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'

async function ensureActiveOrgInNodeRegion(
	ctx: ReservationsAuthContext,
): Promise<Response | null> {
	const org = await findActiveOrganizationById(ctx.orgId)
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

async function resolveLocationParam(
	c: Context,
	ctx: ReservationsAuthContext,
	locationId: string | undefined,
): Promise<
	{ ok: true; locationId: string } | { ok: false; response: Response }
> {
	const check = requireReservationsLocation(ctx, locationId)
	if (!check.ok) return check
	return { ok: true, locationId: check.locationId }
}

export const reservationsOperatorRoutes = new Hono()

const optionalLocationQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128).optional(),
})

const requiredLocationQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
})

// 1. Setup scope routes
reservationsOperatorRoutes.get(
	'/setup/overview',
	rsvGuard({
		scope: 'setup',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const query = readQuery(c, optionalLocationQuerySchema)
		if ('error' in query) return query.error

		if (query.data.locationId) {
			const locCheck = await resolveLocationParam(c, ctx, query.data.locationId)
			if (!locCheck.ok) return locCheck.response
		}

		const db = await getTenantDb(ctx.orgId)
		const [locations, areas, tables, combos, services, turnTimes] =
			await Promise.all([
				db.select().from(rsvLocationSettings),
				db.select().from(rsvAreas),
				db.select().from(rsvTables),
				db.select().from(rsvTableCombos),
				db.select().from(rsvServices),
				db.select().from(rsvTurnTimes),
			])

		const targetLoc = query.data.locationId
		const filterLoc = <T extends { locationId: string }>(rows: T[]) => {
			const scoped = filterReservationsLocations(ctx, rows)
			return targetLoc
				? scoped.filter((row) => row.locationId === targetLoc)
				: scoped
		}

		return json({
			ok: true,
			orgId: ctx.orgId,
			locations: filterLoc(locations),
			areas: filterLoc(areas),
			tables: filterLoc(tables),
			combos: filterLoc(combos),
			services: filterLoc(services),
			turnTimes: filterLoc(turnTimes),
		})
	},
)

const updateLocationSettingsBodySchema = z.object({
	enabled: z.boolean().optional(),
	onlineEnabled: z.boolean().optional(),
	timeZone: z.string().trim().min(1).max(64).optional(),
})

reservationsOperatorRoutes.post(
	'/setup/locations/:locationId/settings',
	rsvGuard({
		scope: 'setup',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const locationId = c.req.param('locationId')
		const locCheck = await resolveLocationParam(c, ctx, locationId)
		if (!locCheck.ok) return locCheck.response

		const parsed = await readJsonBody(c, updateLocationSettingsBodySchema)
		if ('error' in parsed) return parsed.error

		try {
			const db = await getTenantDb(ctx.orgId)
			const now = Date.now()
			await db
				.insert(rsvLocationSettings)
				.values({
					locationId: locCheck.locationId,
					enabled: parsed.data.enabled ?? true,
					onlineEnabled: parsed.data.onlineEnabled ?? false,
					timeZone: parsed.data.timeZone ?? 'UTC',
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: rsvLocationSettings.locationId,
					set: {
						...(parsed.data.enabled !== undefined
							? { enabled: parsed.data.enabled }
							: {}),
						...(parsed.data.onlineEnabled !== undefined
							? { onlineEnabled: parsed.data.onlineEnabled }
							: {}),
						...(parsed.data.timeZone !== undefined
							? { timeZone: parsed.data.timeZone }
							: {}),
						updatedAt: now,
					},
				})

			const updated = await db
				.select()
				.from(rsvLocationSettings)
				.where(eq(rsvLocationSettings.locationId, locCheck.locationId))
				.get()

			return json({ ok: true, orgId: ctx.orgId, settings: updated })
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

reservationsOperatorRoutes.get(
	'/experiences',
	rsvGuard({
		scope: 'setup',
		feature: 'experiences',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const query = readQuery(c, requiredLocationQuerySchema)
		if ('error' in query) return query.error

		const locCheck = await resolveLocationParam(c, ctx, query.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const db = await getTenantDb(ctx.orgId)
		const experiences = await db
			.select()
			.from(rsvExperiences)
			.where(eq(rsvExperiences.locationId, locCheck.locationId))

		return json({ ok: true, orgId: ctx.orgId, experiences })
	},
)

// 2. Book & Waitlist scope routes
reservationsOperatorRoutes.get(
	'/book/day',
	rsvGuard({
		scope: 'book',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const query = readQuery(c, requiredLocationQuerySchema)
		if ('error' in query) return query.error

		const locCheck = await resolveLocationParam(c, ctx, query.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const businessDate =
			query.data.date ?? new Date().toISOString().slice(0, 10)
		const db = await getTenantDb(ctx.orgId)
		const [reservations, versionRow] = await Promise.all([
			db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.locationId, locCheck.locationId)),
			db
				.select()
				.from(rsvDayVersions)
				.where(eq(rsvDayVersions.locationId, locCheck.locationId))
				.get(),
		])

		return json({
			ok: true,
			orgId: ctx.orgId,
			locationId: locCheck.locationId,
			businessDate,
			dayVersion: versionRow?.version ?? 0,
			reservations: reservations.filter((r) => r.businessDate === businessDate),
		})
	},
)

const createOperatorReservationSchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	localStartMin: z.number().int().min(0).max(1800),
	partySize: z.number().int().min(1).max(99),
	firstName: z.string().trim().min(1).max(120),
	lastName: z.string().trim().max(120).optional().default(''),
	phoneE164: z.string().trim().max(32).optional().nullable(),
})

reservationsOperatorRoutes.post(
	'/book/reservations',
	rsvGuard({
		scope: 'book',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await readJsonBody(c, createOperatorReservationSchema)
		if ('error' in parsed) return parsed.error

		const locCheck = await resolveLocationParam(c, ctx, parsed.data.locationId)
		if (!locCheck.ok) return locCheck.response

		try {
			const created = await withReservationWrite(
				{
					orgId: ctx.orgId,
					locationId: locCheck.locationId,
					dates: [parsed.data.businessDate],
				},
				async (tx, helpers) => {
					const [guest] = await tx
						.insert(rsvGuests)
						.values({
							firstName: parsed.data.firstName,
							lastName: parsed.data.lastName,
							phoneE164: parsed.data.phoneE164 ?? null,
						})
						.returning()

					const startAt = helpers.now + 3_600_000
					const endAt = startAt + 90 * 60_000
					const confirmationCode = `RSV${Math.random().toString(36).slice(2, 8).toUpperCase()}`

					const [reservation] = await tx
						.insert(rsvReservations)
						.values({
							locationId: locCheck.locationId,
							guestId: guest!.id,
							confirmationCode,
							businessDate: parsed.data.businessDate,
							localStartMin: parsed.data.localStartMin,
							timeZone: helpers.dayState?.settings?.timeZone ?? 'UTC',
							startAt,
							endAt,
							durationMin: 90,
							partySize: parsed.data.partySize,
							status: 'booked',
							channel: 'host',
							createdByKind: 'operator',
							createdById: ctx.userId,
						})
						.returning()

					return reservation!
				},
			)

			return json({ ok: true, orgId: ctx.orgId, reservation: created }, 201)
		} catch (error) {
			return handleRouteError(error)
		}
	},
)

reservationsOperatorRoutes.get(
	'/waitlist',
	rsvGuard({
		scope: 'book',
		feature: 'waitlist',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const query = readQuery(c, requiredLocationQuerySchema)
		if ('error' in query) return query.error

		const locCheck = await resolveLocationParam(c, ctx, query.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const db = await getTenantDb(ctx.orgId)
		const entries = await db
			.select()
			.from(rsvWaitlistEntries)
			.where(eq(rsvWaitlistEntries.locationId, locCheck.locationId))

		return json({ ok: true, orgId: ctx.orgId, entries })
	},
)

// 3. Guests scope routes
reservationsOperatorRoutes.get(
	'/guests',
	rsvGuard({
		scope: 'guests',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const db = await getTenantDb(ctx.orgId)
		const guests = await db.select().from(rsvGuests)
		return json({ ok: true, orgId: ctx.orgId, guests })
	},
)

const createGuestBodySchema = z.object({
	firstName: z.string().trim().min(1).max(120),
	lastName: z.string().trim().max(120).optional().default(''),
	phoneE164: z.string().trim().max(32).optional().nullable(),
	emailNorm: z.string().trim().email().max(255).optional().nullable(),
})

reservationsOperatorRoutes.post(
	'/guests',
	rsvGuard({
		scope: 'guests',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await readJsonBody(c, createGuestBodySchema)
		if ('error' in parsed) return parsed.error

		const db = await getTenantDb(ctx.orgId)
		const [guest] = await db
			.insert(rsvGuests)
			.values({
				firstName: parsed.data.firstName,
				lastName: parsed.data.lastName,
				phoneE164: parsed.data.phoneE164 ?? null,
				emailNorm: parsed.data.emailNorm?.toLowerCase() ?? null,
			})
			.returning()

		return json({ ok: true, orgId: ctx.orgId, guest }, 201)
	},
)

// 4. Reports scope routes
reservationsOperatorRoutes.get(
	'/reports/summary',
	rsvGuard({
		scope: 'reports',
		grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const query = readQuery(c, requiredLocationQuerySchema)
		if ('error' in query) return query.error

		const locCheck = await resolveLocationParam(c, ctx, query.data.locationId)
		if (!locCheck.ok) return locCheck.response

		const db = await getTenantDb(ctx.orgId)
		const rows = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.locationId, locCheck.locationId))

		return json({
			ok: true,
			orgId: ctx.orgId,
			locationId: locCheck.locationId,
			totalReservations: rows.length,
		})
	},
)

// 5. Payments scope routes
const refundPaymentBodySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	paymentId: z.string().trim().min(1).max(128),
})

reservationsOperatorRoutes.post(
	'/payments/refund',
	rsvGuard({
		scope: 'payments',
		feature: 'payments',
		write: true,
		grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
	}),
	async (c) => {
		const ctx = getRsvAuth(c)
		const orgErr = await ensureActiveOrgInNodeRegion(ctx)
		if (orgErr) return orgErr

		const parsed = await readJsonBody(c, refundPaymentBodySchema)
		if ('error' in parsed) return parsed.error

		const locCheck = await resolveLocationParam(c, ctx, parsed.data.locationId)
		if (!locCheck.ok) return locCheck.response

		return json({
			ok: true,
			orgId: ctx.orgId,
			locationId: locCheck.locationId,
			paymentId: parsed.data.paymentId,
			status: 'refund_requested',
		})
	},
)
