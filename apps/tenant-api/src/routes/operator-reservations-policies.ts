import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { handleRouteError, json, readJsonBody } from '../lib/http.ts'
import { requireReservationsLocation } from '../lib/reservations-auth.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	ensureActiveOrgInNodeRegion,
	getRsvAuth,
	rsvGuard,
} from '../lib/reservations-guard.ts'
import {
	archivePolicy,
	createPolicy,
	listPolicies,
	policyInputSchema,
	policyUpdateSchema,
	updatePolicy,
} from '../services/rsv-policy-service.ts'

/**
 * `/operator/reservations/setup/.../policies`: payment policy CRUD (scope
 * `setup`). Reads need `read:reservation_settings:any`, writes
 * `update:reservation_settings:any`. Money kinds are refused with a 404 when
 * the `payments` feature is off and with 409 `policy_unavailable` when the
 * processor does not support them.
 */
export const operatorReservationsPoliciesRoutes = new Hono()

const readGuard = rsvGuard({
	scope: 'setup',
	grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
})
const writeGuard = rsvGuard({
	scope: 'setup',
	grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	write: true,
})

function wrap(handler: (c: Context) => Promise<Response>) {
	return async (c: Context) => {
		try {
			const ctx = getRsvAuth(c)
			const orgErr = await ensureActiveOrgInNodeRegion(ctx)
			if (orgErr) return orgErr
			return await handler(c)
		} catch (error) {
			return handleRouteError(error)
		}
	}
}

function locationFor(c: Context, bodyLocation?: string | null) {
	const ctx = getRsvAuth(c)
	const raw =
		c.req.param('locationId') ?? c.req.query('locationId') ?? bodyLocation
	return requireReservationsLocation(ctx, raw)
}

const listHandler = wrap(async (c) => {
	const ctx = getRsvAuth(c)
	const loc = locationFor(c)
	if (!loc.ok) return loc.response
	const db = await getTenantDb(ctx.orgId)
	const includeArchived = c.req.query('includeArchived') === 'true'
	const policies = await listPolicies(db, loc.locationId, { includeArchived })
	return json({ locationId: loc.locationId, policies })
})

const createHandler = wrap(async (c) => {
	const ctx = getRsvAuth(c)
	const loc = locationFor(c)
	if (!loc.ok) return loc.response
	const body = await readJsonBody(c, policyInputSchema)
	if ('error' in body) return body.error
	const db = await getTenantDb(ctx.orgId)
	const context = await getReservationsContext(ctx.orgId)
	const policy = await createPolicy({
		db,
		orgId: ctx.orgId,
		locationId: loc.locationId,
		actorId: ctx.userId,
		input: body.data,
		paymentsFeature: ctx.features.payments,
		context,
	})
	return json({ policy }, 201)
})

const updateHandler = wrap(async (c) => {
	const ctx = getRsvAuth(c)
	const loc = locationFor(c)
	if (!loc.ok) return loc.response
	const policyId = c.req.param('policyId') ?? ''
	const body = await readJsonBody(c, policyUpdateSchema)
	if ('error' in body) return body.error
	const db = await getTenantDb(ctx.orgId)
	const context = await getReservationsContext(ctx.orgId)
	const policy = await updatePolicy({
		db,
		orgId: ctx.orgId,
		locationId: loc.locationId,
		policyId,
		actorId: ctx.userId,
		patch: body.data,
		paymentsFeature: ctx.features.payments,
		context,
	})
	return json({ policy })
})

const archiveHandler = wrap(async (c) => {
	const ctx = getRsvAuth(c)
	const loc = locationFor(c)
	if (!loc.ok) return loc.response
	const db = await getTenantDb(ctx.orgId)
	await archivePolicy({
		db,
		orgId: ctx.orgId,
		locationId: loc.locationId,
		policyId: c.req.param('policyId') ?? '',
		actorId: ctx.userId,
	})
	return json({ ok: true })
})

/** `PUT /policies` with `{ locationId, policyId?, ...fields, expectedVersion? }`. */
const upsertHandler = wrap(async (c) => {
	const ctx = getRsvAuth(c)
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return json({ error: 'Invalid JSON body' }, 400)
	}
	const envelope = z
		.object({
			locationId: z.string().trim().min(1).max(128),
			policyId: z.string().trim().min(1).max(128).optional(),
		})
		.loose()
		.safeParse(raw)
	if (!envelope.success) return json({ error: 'Invalid request' }, 400)
	const { locationId, policyId, ...rest } = envelope.data
	const loc = requireReservationsLocation(ctx, locationId)
	if (!loc.ok) return loc.response
	const db = await getTenantDb(ctx.orgId)
	const context = await getReservationsContext(ctx.orgId)
	if (policyId) {
		const patch = policyUpdateSchema.safeParse(rest)
		if (!patch.success) return json({ error: 'Invalid request' }, 400)
		const policy = await updatePolicy({
			db,
			orgId: ctx.orgId,
			locationId: loc.locationId,
			policyId,
			actorId: ctx.userId,
			patch: patch.data,
			paymentsFeature: ctx.features.payments,
			context,
		})
		return json({ policy })
	}
	const input = policyInputSchema.safeParse(rest)
	if (!input.success) return json({ error: 'Invalid request' }, 400)
	const policy = await createPolicy({
		db,
		orgId: ctx.orgId,
		locationId: loc.locationId,
		actorId: ctx.userId,
		input: input.data,
		paymentsFeature: ctx.features.payments,
		context,
	})
	return json({ policy }, 201)
})

operatorReservationsPoliciesRoutes.get('/policies', readGuard, listHandler)
operatorReservationsPoliciesRoutes.get(
	'/locations/:locationId/policies',
	readGuard,
	listHandler,
)
operatorReservationsPoliciesRoutes.put('/policies', writeGuard, upsertHandler)
operatorReservationsPoliciesRoutes.post(
	'/locations/:locationId/policies',
	writeGuard,
	createHandler,
)
operatorReservationsPoliciesRoutes.put(
	'/locations/:locationId/policies/:policyId',
	writeGuard,
	updateHandler,
)
operatorReservationsPoliciesRoutes.delete(
	'/locations/:locationId/policies/:policyId',
	writeGuard,
	archiveHandler,
)
