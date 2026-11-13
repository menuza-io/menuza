import { Hono, type Context } from 'hono'
import {
	posOnlineOrderCommandSchema,
	posOnlineOrderRefundSchema,
	posOnlineOrdersGrants,
	posOnlineOrdersSearchQuerySchema,
} from '@repo/common/pos-online-orders'
import {
	posAvailabilityCommandSchema,
	posPauseCommandSchema,
	posStationControlsAllowed,
} from '@repo/common/pos-station-controls'
import { authenticatePosDevice, posError } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import { HttpError, json, readJsonBody } from '../lib/http.ts'
import { readIdempotencyKey } from '../lib/reservations-public-auth.ts'
import { ordersGate } from '../services/pos-apps-service.ts'
import {
	onlineOrderCommand,
	onlineOrderContact,
	onlineOrderDetail,
	onlineOrderRefund,
	onlineOrdersFeed,
	onlineOrdersSearch,
	type OnlineOrdersActor,
} from '../services/pos-online-orders-service.ts'
import { touchDevice } from '../services/pos-service.ts'
import {
	stationAvailability,
	stationControlsState,
	stationPause,
	type StationControlsActor,
	type StationControlsFailure,
} from '../services/pos-station-controls-service.ts'
import { type OrderServiceFailure } from '../services/order-service.ts'

/**
 * Station's Orders app: the location's online orders on a paired terminal,
 * from arrival to handed over (`/pos/orders` is the till's own upload). Every
 * call verifies the device, the Orders switch, its server-bound location and
 * a current `Pos-Staff-Session`; the person's till role decides what they may
 * do. Guest data goes only to this tablet, `no-store`.
 */
export const posOnlineOrdersRoutes = new Hono()

posOnlineOrdersRoutes.onError((error) => {
	if (error instanceof HttpError) return error.toResponse()
	// What failed, never with what: no guest data in logs.
	console.error(
		'Station orders failed',
		error instanceof Error ? error.name : 'unknown',
	)
	return posError(500, 'orders_unavailable')
})

async function authorize(c: Context): Promise<
	| {
			actor: OnlineOrdersActor
			db: Parameters<typeof onlineOrdersFeed>[0]
			role: 'cashier' | 'manager'
	  }
	| { error: Response }
> {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth
	const { pos } = auth
	const gate = ordersGate(pos.device)
	if (!gate.ok) return { error: posError(403, gate.code) }
	const verified = await verifyPosStaffSession(c, pos)
	if ('error' in verified) return verified
	await touchDevice(pos.db, pos.device).catch(() => {})
	return {
		db: pos.db,
		role: verified.session.role,
		actor: {
			orgId: pos.orgId,
			locationId: gate.locationId,
			deviceId: pos.device.id,
			staffId: verified.session.staffId,
			grants: posOnlineOrdersGrants(verified.session),
		},
	}
}

function failure(result: OrderServiceFailure) {
	return Response.json(
		{
			error: result.code,
			...(result.details && 'refundableCents' in result.details
				? { refundableCents: result.details.refundableCents }
				: {}),
		},
		{
			status: result.status,
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}

posOnlineOrdersRoutes.get('/', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	return json(await onlineOrdersFeed(auth.db, auth.actor))
})

/**
 * Today's and recent orders at this location by number, name or the phone's
 * last digits. A phone search needs the contact grant; results carry the same
 * summary as the inbox (a name, never a phone).
 */
posOnlineOrdersRoutes.get('/search', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const raw = c.req.query()
	// Before parsing: a person without the grant learns nothing from a phone search.
	if ('phone' in raw && !auth.actor.grants.contact)
		return posError(403, 'permission_required')
	const parsed = posOnlineOrdersSearchQuerySchema.safeParse(raw)
	if (!parsed.success) return posError(400, 'invalid_search')
	const result = await onlineOrdersSearch(auth.db, auth.actor, parsed.data)
	return result.ok ? json(result.data) : failure(result.failure)
})

/**
 * Manager controls at this terminal's location: online ordering's pause and a
 * dish's sold-out switch. A signed-in manager only (the till role that may
 * cancel and refund); the App makes the change from ids, so its presets, menu,
 * site cache purge and activity log are the same as the App's own pages.
 */
async function authorizeControls(
	c: Context,
): Promise<
	| { db: Parameters<typeof onlineOrdersFeed>[0]; actor: StationControlsActor }
	| { error: Response }
> {
	const auth = await authorize(c)
	if ('error' in auth) return auth
	if (!posStationControlsAllowed({ role: auth.role }))
		return { error: posError(403, 'permission_required') }
	return {
		db: auth.db,
		actor: {
			orgId: auth.actor.orgId,
			locationId: auth.actor.locationId,
			deviceId: auth.actor.deviceId,
			staffId: auth.actor.staffId,
		},
	}
}

function controlsFailure(failure: StationControlsFailure) {
	return posError(failure.status, failure.code)
}

posOnlineOrdersRoutes.get('/controls', async (c) => {
	const auth = await authorizeControls(c)
	if ('error' in auth) return auth.error
	const result = await stationControlsState(auth.db, auth.actor)
	return result.ok ? json(result.data) : controlsFailure(result.failure)
})

posOnlineOrdersRoutes.post('/controls/pause', async (c) => {
	const auth = await authorizeControls(c)
	if ('error' in auth) return auth.error
	const body = await readJsonBody(c, posPauseCommandSchema)
	if ('error' in body) return body.error
	const result = await stationPause(auth.db, auth.actor, body.data)
	return result.ok ? json(result.data) : controlsFailure(result.failure)
})

posOnlineOrdersRoutes.post('/controls/availability', async (c) => {
	const auth = await authorizeControls(c)
	if ('error' in auth) return auth.error
	const body = await readJsonBody(c, posAvailabilityCommandSchema)
	if ('error' in body) return body.error
	const result = await stationAvailability(auth.db, auth.actor, body.data)
	return result.ok ? json(result.data) : controlsFailure(result.failure)
})

async function detailResponse(
	auth: {
		actor: OnlineOrdersActor
		db: Parameters<typeof onlineOrdersFeed>[0]
	},
	orderId: string,
	status: 200 | 201 = 200,
) {
	const order = await onlineOrderDetail(auth.db, auth.actor, orderId)
	if (!order) return posError(404, 'order_not_found')
	return json(
		{ order, grants: auth.actor.grants, serverNow: Date.now() },
		status,
	)
}

posOnlineOrdersRoutes.get('/:id', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	return detailResponse(auth, c.req.param('id'))
})

posOnlineOrdersRoutes.post('/:id/command', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const body = await readJsonBody(c, posOnlineOrderCommandSchema)
	if ('error' in body) return body.error
	const result = await onlineOrderCommand(
		auth.db,
		auth.actor,
		c.req.param('id'),
		body.data,
	)
	if (!result.ok) return failure(result.failure)
	return detailResponse(auth, c.req.param('id'))
})

posOnlineOrdersRoutes.post('/:id/refunds', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	// Before the key and body: a person without the grant learns nothing more.
	if (!auth.actor.grants.refund) return posError(403, 'permission_required')
	const idempotencyKey = readIdempotencyKey(c)
	if (!idempotencyKey) return posError(400, 'idempotency_key_required')
	const body = await readJsonBody(c, posOnlineOrderRefundSchema)
	if ('error' in body) return body.error
	const result = await onlineOrderRefund(
		auth.db,
		auth.actor,
		c.req.param('id'),
		body.data,
		idempotencyKey,
	)
	if (!result.ok) return failure(result.failure)
	return detailResponse(
		auth,
		c.req.param('id'),
		result.data.replayed ? 200 : 201,
	)
})

/** The guest's full phone and email, one order at a time, recorded. */
posOnlineOrdersRoutes.post('/:id/contact', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const result = await onlineOrderContact(
		auth.db,
		auth.actor,
		c.req.param('id'),
	)
	if (!result.ok) return failure(result.failure)
	return json(result.data)
})
