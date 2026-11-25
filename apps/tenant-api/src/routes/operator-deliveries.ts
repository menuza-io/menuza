import { Hono, type Context } from 'hono'
import {
	deliveryAvailabilitySchema,
	deliveryBoardQuerySchema,
	deliveryReassignSchema,
	deliveryRunCreateSchema,
	deliveryStopDeliveredSchema,
} from '@repo/common/delivery-runs'
import { getTenantDb } from '@repo/tenant-db'
import { z } from 'zod'
import { maskedCallOffered } from '../lib/masked-call.ts'
import {
	assertOperatorOrg,
	authenticateOrdersOperator,
	type OperatorOrderAuth,
} from './operator-orders.ts'
import {
	createRun,
	loadBoard,
	markStopDelivered,
	pickUpRun,
	reassignRun,
	releaseStop,
	setDriverAvailability,
	type DeliveryActor,
	type DeliveryResult,
} from '../services/delivery-run-service.ts'

/**
 * `/operator/deliveries/*`: the App's Deliveries board (#287), on the orders
 * token. It needs the token's `deliveries` claim (App signs it only while the
 * organization's `delivery.in_house` flag is on) and the member's location
 * limit, and every write needs `orders:write`. A driver never reaches these
 * routes: drivers sign in on Station with their PIN.
 */
export const operatorDeliveryRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Authed = { auth: OperatorOrderAuth; actor: DeliveryActor }

async function authorize(
	c: Context,
	scope: 'orders:read' | 'orders:write',
): Promise<Authed | { error: Response }> {
	const result = await authenticateOrdersOperator(c, scope)
	if ('error' in result) return result
	if (!result.auth.deliveries) {
		return {
			error: c.json(
				{ error: 'deliveries_not_enabled' },
				403,
				NO_STORE,
			),
		}
	}
	const denied = await assertOperatorOrg(result.auth.orgId)
	if (denied) return { error: denied.error }
	return {
		auth: result.auth,
		actor: { kind: 'manager', origin: 'operator', id: result.auth.userId },
	}
}

const visible = (auth: OperatorOrderAuth, locationId: string) =>
	auth.locationIds === null || auth.locationIds.includes(locationId)

function respond<T>(c: Context, result: DeliveryResult<T>) {
	return result.ok
		? c.json(result.value, 200, NO_STORE)
		: c.json(
				{ error: result.code, ...(result.message ? { message: result.message } : {}) },
				result.status,
				NO_STORE,
			)
}

async function body<S extends z.ZodTypeAny>(c: Context, schema: S) {
	const parsed = schema.safeParse(await c.req.json().catch(() => null))
	return parsed.success ? (parsed.data as z.infer<S>) : null
}

const invalid = (c: Context) => c.json({ error: 'invalid_request' }, 400, NO_STORE)
const notFound = (c: Context) => c.json({ error: 'location_not_found' }, 404, NO_STORE)

operatorDeliveryRoutes.get('/board', async (c) => {
	const authed = await authorize(c, 'orders:read')
	if ('error' in authed) return authed.error
	const query = deliveryBoardQuerySchema.safeParse(c.req.query())
	if (!query.success) return invalid(c)
	if (!visible(authed.auth, query.data.locationId)) return notFound(c)
	const db = await getTenantDb(authed.auth.orgId)
	return c.json(
		await loadBoard(db, query.data.locationId, { canCall: maskedCallOffered }),
		200,
		NO_STORE,
	)
})

/** A manager assigns one or several ready orders to a driver as a run. */
operatorDeliveryRoutes.post('/runs', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const input = await body(c, deliveryRunCreateSchema)
	if (!input) return invalid(c)
	if (!visible(authed.auth, input.locationId)) return notFound(c)
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await createRun(db, {
			orgId: authed.auth.orgId,
			locationId: input.locationId,
			driverStaffId: input.driverStaffId,
			orderIds: input.orderIds,
			actor: authed.actor,
		}),
	)
})

operatorDeliveryRoutes.post('/runs/:id/reassign', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const input = await body(c, deliveryReassignSchema)
	if (!input) return invalid(c)
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await reassignRun(db, {
			orgId: authed.auth.orgId,
			runId: c.req.param('id'),
			driverStaffId: input.driverStaffId,
			actor: authed.actor,
			scope: authed.auth.locationIds,
		}),
	)
})

operatorDeliveryRoutes.post('/runs/:id/pickup', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await pickUpRun(db, {
			orgId: authed.auth.orgId,
			runId: c.req.param('id'),
			actor: authed.actor,
			driverStaffId: null,
			scope: authed.auth.locationIds,
		}),
	)
})

/** A manager marks a stop delivered on the driver's behalf. */
operatorDeliveryRoutes.post('/stops/:id/delivered', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const input = await body(c, deliveryStopDeliveredSchema)
	if (!input) return invalid(c)
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await markStopDelivered(db, {
			orgId: authed.auth.orgId,
			stopId: c.req.param('id'),
			actor: authed.actor,
			driverStaffId: null,
			cashCollectedCents: input.cashCollectedCents,
			scope: authed.auth.locationIds,
		}),
	)
})

/** A manager takes a delivery back so it can be assigned again. */
operatorDeliveryRoutes.post('/stops/:id/release', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await releaseStop(db, {
			orgId: authed.auth.orgId,
			stopId: c.req.param('id'),
			actor: authed.actor,
			scope: authed.auth.locationIds,
		}),
	)
})

const availabilityBody = deliveryAvailabilitySchema.extend({
	locationId: z.string().trim().min(1).max(100),
})

operatorDeliveryRoutes.post('/drivers/:staffId/availability', async (c) => {
	const authed = await authorize(c, 'orders:write')
	if ('error' in authed) return authed.error
	const input = await body(c, availabilityBody)
	if (!input) return invalid(c)
	if (!visible(authed.auth, input.locationId)) return notFound(c)
	const db = await getTenantDb(authed.auth.orgId)
	return respond(
		c,
		await setDriverAvailability(db, {
			staffId: c.req.param('staffId'),
			locationId: input.locationId,
			unavailable: input.unavailable,
			actor: authed.actor,
		}),
	)
})
