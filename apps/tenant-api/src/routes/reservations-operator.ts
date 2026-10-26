import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb, rsvExperiences } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { json, readQuery } from '../lib/http.ts'
import { stationContactRedaction } from '../lib/reservations-station.ts'
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
import { operatorReservationsExperiencesRoutes } from './operator-reservations-experiences.ts'
import { operatorReservationsGuestsRoutes } from './operator-reservations-guests.ts'
import { operatorReservationsPaymentsRoutes } from './operator-reservations-payments.ts'
import { operatorReservationsPoliciesRoutes } from './operator-reservations-policies.ts'
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

// A Station till's token sees guest contact details only with the guest grant.
reservationsOperatorRoutes.use('*', stationContactRedaction())

const requiredLocationQuerySchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
})

// 0. Payments scope routes
reservationsOperatorRoutes.route(
	'/payments',
	operatorReservationsPaymentsRoutes,
)

// 1. Setup scope routes
// Experiences mount first so the setup router never answers their paths.
reservationsOperatorRoutes.route(
	'/setup/locations/:locationId/experiences',
	operatorReservationsExperiencesRoutes,
)
reservationsOperatorRoutes.route('/setup', operatorReservationsPoliciesRoutes)
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
// The sub-router's own root only answers without the trailing slash.
reservationsOperatorRoutes.route(
	'/book/waitlist/',
	operatorReservationsWaitlistRoutes,
)
reservationsOperatorRoutes.route('/book', operatorReservationsBookRoutes)

// 3. Guests scope routes
reservationsOperatorRoutes.route('/guests', operatorReservationsGuestsRoutes)

// 4. Payments scope routes live in operator-reservations-payments.ts (the
// refund endpoint is `POST /payments/reservations/:id/refund`).

export const reservationsOperatorRouter = reservationsOperatorRoutes
