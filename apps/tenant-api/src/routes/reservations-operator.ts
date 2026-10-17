import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb, rsvExperiences, rsvReservations } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { json, readJsonBody, readQuery } from '../lib/http.ts'
import {
	requireReservationsLocation,
	type ReservationsAuthContext,
} from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import { operatorReservationsBookRoutes } from './operator-reservations-book.ts'
import { operatorReservationsGuestsRoutes } from './operator-reservations-guests.ts'
import { operatorReservationsSetupRoutes } from './operator-reservations-setup.ts'
import { operatorReservationsWaitlistRoutes } from './reservations-waitlist.ts'

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

const requiredLocationQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
})

// 1. Setup scope routes
reservationsOperatorRoutes.route('/setup', operatorReservationsSetupRoutes)

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
reservationsOperatorRoutes.route(
	'/book/waitlist',
	operatorReservationsWaitlistRoutes,
)
reservationsOperatorRoutes.route('/book', operatorReservationsBookRoutes)

// 3. Guests scope routes
reservationsOperatorRoutes.route('/guests', operatorReservationsGuestsRoutes)

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

export const reservationsOperatorRouter = reservationsOperatorRoutes
