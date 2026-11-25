import { Hono, type Context } from 'hono'
import {
	deliveryAvailabilitySchema,
	deliveryClaimSchema,
	deliveryPositionSchema,
	deliveryReassignSchema,
	deliveryRunCreateSchema,
	deliveryStopDeliveredSchema,
	deliveryStopProblemSchema,
} from '@repo/common/delivery-runs'
import { type TenantDatabase } from '@repo/tenant-db'
import { z } from 'zod'
import { getMaskedCallBridge, maskedCallOffered } from '../lib/masked-call.ts'
import { inHouseDeliveryEnabled } from '../lib/delivery-switches.ts'
import { HttpError, json, readJsonBody } from '../lib/http.ts'
import { authenticatePosDevice, posError } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import {
	clearDriverPosition,
	createRun,
	isDeliveryDriver,
	loadBoard,
	loadDriverSelf,
	loadStopCallParties,
	markStopDelivered,
	pickUpRun,
	reassignRun,
	releaseStop,
	reportStopProblem,
	setDriverAvailability,
	shareDriverPosition,
	takeDriverNotices,
	type DeliveryActor,
	type DeliveryResult,
} from '../services/delivery-run-service.ts'
import { touchDevice } from '../services/pos-service.ts'

/**
 * Station's Deliveries app (#287): the location's own-driver deliveries on a
 * paired terminal. Every call verifies the device, the organization's
 * `delivery.in_house` flag, the terminal's server-bound location, sign-in
 * required and a current `Pos-Staff-Session`. What a person may do follows who
 * signed in:
 *
 * - a manager (the till role): the board, assigning, taking back, reassigning,
 *   marking delivered on a driver's behalf, setting a driver unavailable;
 * - a driver (an open job whose position "Delivers orders"): their own open
 *   run only (claim ready orders, picked up, delivered, problem, call, share
 *   position). Another driver's run and a finished run answer 404;
 * - anyone else: nothing.
 *
 * Guest names, addresses and notes go to this tablet only, `no-store`.
 */
export const posDeliveriesRoutes = new Hono()

posDeliveriesRoutes.onError((error) => {
	if (error instanceof HttpError) return error.toResponse()
	// What failed, never with what: no guest data in logs.
	console.error(
		'Station deliveries failed',
		error instanceof Error ? error.name : 'unknown',
	)
	return posError(500, 'deliveries_unavailable')
})

type Auth = {
	db: TenantDatabase
	orgId: string
	locationId: string
	staffId: string
	manager: boolean
	actor: (kind: 'manager' | 'driver') => DeliveryActor
}

async function authorize(c: Context): Promise<Auth | { error: Response }> {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth
	const { pos } = auth
	if (!pos.device.signInRequired) {
		return { error: posError(403, 'deliveries_needs_sign_in') }
	}
	if (!pos.device.locationId) {
		return { error: posError(403, 'deliveries_needs_location') }
	}
	if (!(await inHouseDeliveryEnabled(pos.orgId))) {
		return { error: posError(403, 'deliveries_not_enabled') }
	}
	const verified = await verifyPosStaffSession(c, pos)
	if ('error' in verified) return verified
	await touchDevice(pos.db, pos.device).catch(() => {})
	const staffId = verified.session.staffId
	return {
		db: pos.db,
		orgId: pos.orgId,
		locationId: pos.device.locationId,
		staffId,
		manager: verified.session.role === 'manager',
		actor: (kind) => ({ kind, origin: 'station', id: `staff:${staffId}` }),
	}
}

function failure(result: Extract<DeliveryResult<unknown>, { ok: false }>) {
	return posError(result.status, result.code)
}

const asResponse = <T>(result: DeliveryResult<T>) =>
	result.ok ? json(result.value) : failure(result)

/** A manager's call; anyone else is refused before anything is read. */
function managerOnly(auth: Auth): Response | null {
	return auth.manager ? null : posError(403, 'permission_required')
}

/** A driver's call; the person must hold a delivering job at this location. */
async function driverOnly(auth: Auth): Promise<Response | null> {
	return (await isDeliveryDriver(auth.db, auth.staffId, auth.locationId))
		? null
		: posError(403, 'not_a_driver')
}

const stationRunCreateSchema = deliveryRunCreateSchema.omit({ locationId: true })

posDeliveriesRoutes.get('/me', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const self = await loadDriverSelf(auth.db, {
		staffId: auth.staffId,
		locationId: auth.locationId,
		manager: auth.manager,
		canCall: maskedCallOffered,
	})
	// A driver reads their notices once; a plain manager has none.
	const notices = self.isDriver
		? await takeDriverNotices(auth.db, auth.staffId)
		: []
	return json({ ...self, notices })
})

posDeliveriesRoutes.get('/board', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = managerOnly(auth)
	if (refused) return refused
	return json(
		await loadBoard(auth.db, auth.locationId, { canCall: () => false }),
	)
})

/** A manager sends ready orders out with a driver. */
posDeliveriesRoutes.post('/runs', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = managerOnly(auth)
	if (refused) return refused
	const parsed = await readJsonBody(c, stationRunCreateSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await createRun(auth.db, {
			orgId: auth.orgId,
			locationId: auth.locationId,
			driverStaffId: body.driverStaffId,
			orderIds: body.orderIds,
			actor: auth.actor('manager'),
		}),
	)
})

/** A driver takes ready orders for themselves. */
posDeliveriesRoutes.post('/claim', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = await driverOnly(auth)
	if (refused) return refused
	const parsed = await readJsonBody(c, deliveryClaimSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await createRun(auth.db, {
			orgId: auth.orgId,
			locationId: auth.locationId,
			driverStaffId: auth.staffId,
			orderIds: body.orderIds,
			actor: auth.actor('driver'),
		}),
	)
})

posDeliveriesRoutes.post('/runs/:id/reassign', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = managerOnly(auth)
	if (refused) return refused
	const parsed = await readJsonBody(c, deliveryReassignSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await reassignRun(auth.db, {
			orgId: auth.orgId,
			runId: c.req.param('id'),
			driverStaffId: body.driverStaffId,
			actor: auth.actor('manager'),
			scope: [auth.locationId],
		}),
	)
})

/** Picked up, all at once: the driver on their own run, or a manager for them. */
posDeliveriesRoutes.post('/runs/:id/pickup', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const asDriver = !auth.manager
	if (asDriver) {
		const refused = await driverOnly(auth)
		if (refused) return refused
	}
	return asResponse(
		await pickUpRun(auth.db, {
			orgId: auth.orgId,
			runId: c.req.param('id'),
			actor: auth.actor(asDriver ? 'driver' : 'manager'),
			driverStaffId: asDriver ? auth.staffId : null,
			scope: [auth.locationId],
		}),
	)
})

posDeliveriesRoutes.post('/stops/:id/delivered', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const asDriver = !auth.manager
	if (asDriver) {
		const refused = await driverOnly(auth)
		if (refused) return refused
	}
	const parsed = await readJsonBody(c, deliveryStopDeliveredSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await markStopDelivered(auth.db, {
			orgId: auth.orgId,
			stopId: c.req.param('id'),
			actor: auth.actor(asDriver ? 'driver' : 'manager'),
			driverStaffId: asDriver ? auth.staffId : null,
			cashCollectedCents: body.cashCollectedCents,
			scope: [auth.locationId],
		}),
	)
})

posDeliveriesRoutes.post('/stops/:id/problem', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const asDriver = !auth.manager
	if (asDriver) {
		const refused = await driverOnly(auth)
		if (refused) return refused
	}
	const parsed = await readJsonBody(c, deliveryStopProblemSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await reportStopProblem(auth.db, {
			orgId: auth.orgId,
			stopId: c.req.param('id'),
			kind: body.kind,
			actor: auth.actor(asDriver ? 'driver' : 'manager'),
			driverStaffId: asDriver ? auth.staffId : null,
			scope: [auth.locationId],
		}),
	)
})

/** A manager takes a delivery back; the order can be assigned again. */
posDeliveriesRoutes.post('/stops/:id/release', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = managerOnly(auth)
	if (refused) return refused
	return asResponse(
		await releaseStop(auth.db, {
			orgId: auth.orgId,
			stopId: c.req.param('id'),
			actor: auth.actor('manager'),
			scope: [auth.locationId],
		}),
	)
})

/**
 * The masked call: the region rings the driver and connects the guest. Neither
 * number crosses to a device, and nothing here logs one.
 */
posDeliveriesRoutes.post('/stops/:id/call', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = await driverOnly(auth)
	if (refused) return refused
	const parties = await loadStopCallParties(auth.db, {
		stopId: c.req.param('id'),
		driverStaffId: auth.staffId,
	})
	if (!parties.ok) return failure(parties)
	const bridge = getMaskedCallBridge()
	if (
		!bridge ||
		!bridge.available() ||
		!parties.value.guestPhone ||
		!parties.value.driverPhone
	) {
		return posError(409, 'call_unavailable')
	}
	let connected = false
	try {
		connected = await bridge.connect({
			driverPhone: parties.value.driverPhone,
			guestPhone: parties.value.guestPhone,
		})
	} catch {
		// Never the numbers: only that the bridge failed.
		connected = false
	}
	return connected ? json({ calling: true }) : posError(503, 'call_failed')
})

const staffIdParam = z.string().trim().min(1).max(100)

/** A manager sets a driver unavailable (or back). */
posDeliveriesRoutes.post('/drivers/:staffId/availability', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = managerOnly(auth)
	if (refused) return refused
	const staffId = staffIdParam.safeParse(c.req.param('staffId'))
	if (!staffId.success) return posError(400, 'invalid_request')
	const parsed = await readJsonBody(c, deliveryAvailabilitySchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await setDriverAvailability(auth.db, {
			staffId: staffId.data,
			locationId: auth.locationId,
			unavailable: body.unavailable,
			actor: auth.actor('manager'),
		}),
	)
})

/** A driver sets themselves unavailable (or back): new assignments stop, current ones finish. */
posDeliveriesRoutes.post('/me/availability', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = await driverOnly(auth)
	if (refused) return refused
	const parsed = await readJsonBody(c, deliveryAvailabilitySchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await setDriverAvailability(auth.db, {
			staffId: auth.staffId,
			locationId: auth.locationId,
			unavailable: body.unavailable,
			actor: auth.actor('driver'),
		}),
	)
})

/** The driver chooses to share where they are while a run is open. */
posDeliveriesRoutes.post('/run/location', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = await driverOnly(auth)
	if (refused) return refused
	const parsed = await readJsonBody(c, deliveryPositionSchema)
	if ('error' in parsed) return parsed.error
	const body = parsed.data
	return asResponse(
		await shareDriverPosition(auth.db, {
			orgId: auth.orgId,
			driverStaffId: auth.staffId,
			lat: body.lat,
			lng: body.lng,
		}),
	)
})

/** The driver stops sharing: the point is deleted now. */
posDeliveriesRoutes.delete('/run/location', async (c) => {
	const auth = await authorize(c)
	if ('error' in auth) return auth.error
	const refused = await driverOnly(auth)
	if (refused) return refused
	await clearDriverPosition(auth.db, auth.staffId)
	return json({ shared: false })
})
