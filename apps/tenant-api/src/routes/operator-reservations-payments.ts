import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json, readJsonBody } from '../lib/http.ts'
import {
	requireReservationsLocation,
	type ReservationsOperatorContext,
} from '../lib/reservations-auth.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import { getTenantDb, rsvReservations } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import {
	listReservationPayments,
	requestOperatorFee,
	requestOperatorRefund,
} from '../services/rsv-payment-service.ts'

/**
 * `/operator/reservations/payments/*` (scope `payments`, feature `payments`).
 * Reading needs the read grant the `payments` scope carries; charging a fee or
 * refunding needs `update:reservation_payment:any` (sensitive, 5-minute
 * tokens, never impersonated). Both only record the decision regionally: the
 * App executes it with the provider (`/api/reservations/payments/*`).
 */
export const operatorReservationsPaymentsRoutes = new Hono()

const readGuard = rsvGuard({
	scope: 'payments',
	feature: 'payments',
	grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
})
const writeGuard = rsvGuard({
	scope: 'payments',
	feature: 'payments',
	grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
	write: true,
})

const reservationIdSchema = z.string().trim().min(1).max(128)

function allowsLocation(ctx: ReservationsOperatorContext) {
	return (locationId: string) => requireReservationsLocation(ctx, locationId).ok
}

async function assertReservationInScope(
	ctx: ReservationsOperatorContext,
	reservationId: string,
) {
	const db = await getTenantDb(ctx.orgId)
	const row = await db
		.select({ locationId: rsvReservations.locationId })
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!row || !allowsLocation(ctx)(row.locationId)) {
		return json({ error: 'not_found' }, 404)
	}
	return null
}

function wrap(
	handler: (c: Context, ctx: ReservationsOperatorContext) => Promise<Response>,
) {
	return async (c: Context) => {
		try {
			const ctx = getRsvAuth(c)
			const orgErr = await ensureActiveOrgInNodeRegion(ctx)
			if (orgErr) return orgErr
			const id = reservationIdSchema.safeParse(c.req.param('id'))
			if (!id.success) return json({ error: 'not_found' }, 404)
			const denied = await assertReservationInScope(ctx, id.data)
			if (denied) return denied
			return await handler(c, ctx)
		} catch (error) {
			return handleRouteError(error)
		}
	}
}

operatorReservationsPaymentsRoutes.get(
	'/reservations/:id',
	readGuard,
	wrap(async (c, ctx) => {
		const result = await listReservationPayments(
			ctx.orgId,
			c.req.param('id') ?? '',
			allowsLocation(ctx),
		)
		return json(result)
	}),
)

const feeBodySchema = z.strictObject({
	kind: z.enum(['no_show_fee', 'late_cancel_fee']),
	amountMinor: z.number().int().min(1).max(10_000_000).nullish(),
	expectedVersion: z.number().int().min(1),
})

operatorReservationsPaymentsRoutes.post(
	'/reservations/:id/fee',
	writeGuard,
	wrap(async (c, ctx) => {
		const body = await readJsonBody(c, feeBodySchema)
		if ('error' in body) return body.error
		const result = await requestOperatorFee({
			orgId: ctx.orgId,
			reservationId: c.req.param('id') ?? '',
			actorId: ctx.userId,
			kind: body.data.kind,
			amountMinor: body.data.amountMinor ?? null,
			expectedVersion: body.data.expectedVersion,
		})
		return json(result, 201)
	}),
)

const refundBodySchema = z.strictObject({
	amountMinor: z.number().int().min(1).max(10_000_000).nullish(),
	reason: z.string().trim().min(1).max(500),
})

operatorReservationsPaymentsRoutes.post(
	'/reservations/:id/refund',
	writeGuard,
	wrap(async (c, ctx) => {
		const body = await readJsonBody(c, refundBodySchema)
		if ('error' in body) return body.error
		const result = await requestOperatorRefund({
			orgId: ctx.orgId,
			reservationId: c.req.param('id') ?? '',
			actorId: ctx.userId,
			amountMinor: body.data.amountMinor ?? null,
			reason: body.data.reason,
		})
		return json(result, 201)
	}),
)
