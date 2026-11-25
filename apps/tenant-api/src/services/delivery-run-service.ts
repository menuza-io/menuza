import {
	cashDueFor,
	driverDisplayName,
	isOpenRunStatus,
	mapUrlForAddress,
	MAX_STOPS_PER_RUN,
	type DeliveryBoard,
	type DeliveryBoardOrder,
	type DeliveryDriverView,
	type DeliveryProblemKindValue,
	type DeliveryRunView,
	type DeliveryStopView,
	type DriverSelf,
} from '@repo/common/delivery-runs'
import { stepActorFor } from '@repo/common/order-steps'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import {
	deliveryDriverNotices,
	deliveryDriverStatus,
	deliveryRunPositions,
	deliveryRuns,
	deliveryRunStops,
	restaurantOrders,
	runTenantTransaction,
	staffJobs,
	staffMembers,
	staffPositions,
	staffScopeAssignments,
	type DeliveryNoticeKind,
	type DeliveryRun,
	type DeliveryRunStop,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { runExclusive } from '../lib/concurrency.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	applyOrderStatusPatchInTx,
	orderWriteQueues,
	settleOrderWriteQueues,
	type OrderTx,
} from './order-service.ts'
import { queueOrderMessage } from './order-messages.ts'
import { loadOrderStepRows, recordOrderStep } from './order-steps.ts'

/**
 * Own-driver deliveries (#287). One service behind the App Orders board
 * (`/operator/deliveries/*`, orders token) and Station (`/pos/deliveries/*`,
 * paired terminal plus the person's PIN session), so the two never disagree.
 *
 * Rules that bite:
 * - an order has at most one active stop (partial unique index), so it cannot be
 *   assigned to two drivers, even by two managers at once;
 * - a driver reaches only their own open run; a finished run has no stops left
 *   on their device (the view is empty), and their live position is deleted;
 * - going out and being delivered use the existing order machinery: the
 *   `out_for_delivery` and `delivered` steps, and `applyOrderStatusPatchInTx` for
 *   `completed`, so there is still one status machine and one timeline;
 * - guest names, phones and addresses are read from the order for display and
 *   are never copied into the run tables.
 */

export type DeliveryActor = {
	kind: 'manager' | 'driver'
	origin: 'operator' | 'station'
	/** The member's user id (App) or `staff:<id>` (Station). Opaque. */
	id: string
}

export type DeliveryResult<T> =
	| { ok: true; value: T }
	| { ok: false; status: 403 | 404 | 409 | 422 | 503; code: string; message?: string }

const ok = <T>(value: T): DeliveryResult<T> => ({ ok: true, value })
const fail = (
	status: 403 | 404 | 409 | 422 | 503,
	code: string,
	message?: string,
): DeliveryResult<never> => ({ ok: false, status, code, message })

type Writer = TenantDatabase | OrderTx

const isUniqueViolation = (error: unknown, depth = 0): boolean =>
	error instanceof Error &&
	depth < 5 &&
	(error.message.includes('UNIQUE constraint failed') ||
		error.message.includes('SQLITE_CONSTRAINT_UNIQUE') ||
		isUniqueViolation(error.cause, depth + 1))

/** The staffing scopes a location's people work in: its own, or the default one. */
export function deliveryScopeIds(locationId: string): string[] {
	return locationId === DEFAULT_SCOPE_ID
		? [DEFAULT_SCOPE_ID]
		: [locationId, DEFAULT_SCOPE_ID]
}

// ---------------------------------------------------------------------------
// Who can drive
// ---------------------------------------------------------------------------

type DriverRow = {
	staffId: string
	firstName: string
	lastName: string
	phone: string | null
}

/**
 * Active staff with an open job whose position "Delivers orders" at the
 * location's staffing scope. Names are staff data: they go to the board and the
 * driver's own device, never into a report without the staff grant.
 */
export async function loadDriverRoster(
	db: Writer,
	locationId: string,
): Promise<DriverRow[]> {
	const scopes = deliveryScopeIds(locationId)
	const rows = await db
		.select({
			staffId: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			phone: staffMembers.phone,
		})
		.from(staffJobs)
		.innerJoin(staffMembers, eq(staffMembers.id, staffJobs.staffId))
		.innerJoin(staffPositions, eq(staffPositions.id, staffJobs.positionId))
		.innerJoin(
			staffScopeAssignments,
			and(
				eq(staffScopeAssignments.staffId, staffJobs.staffId),
				eq(staffScopeAssignments.scopeId, staffJobs.scopeId),
			),
		)
		.where(
			and(
				inArray(staffJobs.scopeId, scopes),
				isNull(staffJobs.effectiveTo),
				eq(staffPositions.deliversOrders, true),
				isNull(staffPositions.archivedAt),
				eq(staffScopeAssignments.active, true),
				eq(staffMembers.status, 'active'),
			),
		)
		.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
	const seen = new Set<string>()
	return rows.filter((row) => {
		if (seen.has(row.staffId)) return false
		seen.add(row.staffId)
		return true
	})
}

export async function isDeliveryDriver(
	db: Writer,
	staffId: string,
	locationId: string,
): Promise<boolean> {
	return (await loadDriverRoster(db, locationId)).some(
		(driver) => driver.staffId === staffId,
	)
}

async function unavailableIds(db: Writer): Promise<Set<string>> {
	const rows = await db
		.select({ staffId: deliveryDriverStatus.staffId })
		.from(deliveryDriverStatus)
		.where(eq(deliveryDriverStatus.unavailable, true))
	return new Set(rows.map((row) => row.staffId))
}

export async function listDrivers(
	db: Writer,
	locationId: string,
): Promise<DeliveryDriverView[]> {
	const [roster, away, open] = await Promise.all([
		loadDriverRoster(db, locationId),
		unavailableIds(db),
		db
			.select({ driver: deliveryRuns.driverStaffId, runs: sql<number>`count(*)` })
			.from(deliveryRuns)
			.where(
				and(
					eq(deliveryRuns.locationId, locationId),
					inArray(deliveryRuns.status, ['assigned', 'on_the_road']),
				),
			)
			.groupBy(deliveryRuns.driverStaffId),
	])
	const counts = new Map(open.map((row) => [row.driver, Number(row.runs)]))
	return roster.map((driver) => ({
		staffId: driver.staffId,
		name: driverDisplayName(driver.firstName, driver.lastName),
		unavailable: away.has(driver.staffId),
		openRuns: counts.get(driver.staffId) ?? 0,
	}))
}

export async function setDriverAvailability(
	db: TenantDatabase,
	input: {
		staffId: string
		locationId: string
		unavailable: boolean
		actor: DeliveryActor
	},
): Promise<DeliveryResult<{ unavailable: boolean }>> {
	if (!(await isDeliveryDriver(db, input.staffId, input.locationId))) {
		return fail(404, 'driver_not_found')
	}
	const now = Date.now()
	await db
		.insert(deliveryDriverStatus)
		.values({
			staffId: input.staffId,
			unavailable: input.unavailable,
			updatedBy: input.actor.id,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: deliveryDriverStatus.staffId,
			set: {
				unavailable: input.unavailable,
				updatedBy: input.actor.id,
				updatedAt: now,
			},
		})
	return ok({ unavailable: input.unavailable })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function firstName(name: string): string {
	return (name.trim().split(/\s+/)[0] ?? '').slice(0, 40)
}

function boardOrder(order: RestaurantOrder, readyAt: number | null): DeliveryBoardOrder {
	return {
		id: order.id,
		number: order.number,
		firstName: firstName(order.contactName),
		address: order.deliveryAddress ?? '',
		unit: order.deliveryUnit ?? null,
		zoneName: null,
		promisedAt: order.promisedAt ? order.promisedAt.getTime() : null,
		readyAt,
		cashDueCents: cashDueFor(order),
		tipCents: order.tipCents,
		currency: order.currency,
	}
}

async function readyTimes(
	db: Writer,
	orderIds: readonly string[],
): Promise<Map<string, number>> {
	const steps = await loadOrderStepRows(db as TenantDatabase, orderIds)
	const times = new Map<string, number>()
	for (const [orderId, rows] of steps) {
		let at: number | null = null
		for (const row of rows) {
			if (row.step === 'ready') at = row.event === 'done' ? row.at : null
		}
		if (at !== null) times.set(orderId, at)
	}
	return times
}

/** Ready delivery orders at a location that no driver holds. */
async function loadUnassigned(
	db: Writer,
	locationId: string,
): Promise<DeliveryBoardOrder[]> {
	const held = db
		.select({ orderId: deliveryRunStops.orderId })
		.from(deliveryRunStops)
		.where(inArray(deliveryRunStops.status, ['pending', 'picked_up', 'problem']))
	const orders = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.locationId, locationId),
				eq(restaurantOrders.fulfillment, 'delivery'),
				eq(restaurantOrders.status, 'ready'),
				sql`${restaurantOrders.id} not in ${held}`,
			),
		)
		.orderBy(asc(restaurantOrders.createdAt))
	const times = await readyTimes(
		db,
		orders.map((order) => order.id),
	)
	return orders
		.map((order) => boardOrder(order, times.get(order.id) ?? null))
		.sort(
			(a, b) =>
				(a.promisedAt ?? a.readyAt ?? 0) - (b.promisedAt ?? b.readyAt ?? 0),
		)
}

type RunBundle = {
	run: DeliveryRun
	stops: DeliveryRunStop[]
	orders: Map<string, RestaurantOrder>
	position: { lat: number; lng: number; updatedAt: number } | null
	driver: DriverRow | null
}

async function bundleRuns(db: Writer, runs: DeliveryRun[]): Promise<RunBundle[]> {
	if (runs.length === 0) return []
	const runIds = runs.map((run) => run.id)
	const stops = await queryInChunks(runIds, (chunk) =>
		db
			.select()
			.from(deliveryRunStops)
			.where(inArray(deliveryRunStops.runId, chunk))
			.orderBy(asc(deliveryRunStops.stopNo)),
	)
	const orderIds = [...new Set(stops.map((stop) => stop.orderId))]
	const orders = await queryInChunks(orderIds, (chunk) =>
		db.select().from(restaurantOrders).where(inArray(restaurantOrders.id, chunk)),
	)
	const positions = await queryInChunks(runIds, (chunk) =>
		db
			.select()
			.from(deliveryRunPositions)
			.where(inArray(deliveryRunPositions.runId, chunk)),
	)
	const driverIds = [...new Set(runs.map((run) => run.driverStaffId))]
	const drivers = await queryInChunks(driverIds, (chunk) =>
		db
			.select({
				staffId: staffMembers.id,
				firstName: staffMembers.firstName,
				lastName: staffMembers.lastName,
				phone: staffMembers.phone,
			})
			.from(staffMembers)
			.where(inArray(staffMembers.id, chunk)),
	)
	const orderById = new Map(orders.map((order) => [order.id, order]))
	const positionByRun = new Map(positions.map((p) => [p.runId, p]))
	const driverById = new Map(drivers.map((d) => [d.staffId, d]))
	return runs.map((run) => {
		const position = positionByRun.get(run.id)
		return {
			run,
			stops: stops.filter((stop) => stop.runId === run.id),
			orders: orderById,
			position: position
				? { lat: position.lat, lng: position.lng, updatedAt: position.updatedAt }
				: null,
			driver: driverById.get(run.driverStaffId) ?? null,
		}
	})
}

export type CallAvailability = (input: {
	guestPhone: string | null
	driverPhone: string | null
}) => boolean

function stopView(
	stop: DeliveryRunStop,
	order: RestaurantOrder | undefined,
	canCall: boolean,
): DeliveryStopView {
	return {
		id: stop.id,
		orderId: stop.orderId,
		number: order?.number ?? '',
		stopNo: stop.stopNo,
		status: stop.status,
		problemKind: stop.problemKind ?? null,
		firstName: order ? firstName(order.contactName) : '',
		address: order?.deliveryAddress ?? '',
		unit: order?.deliveryUnit ?? null,
		notes: order?.deliveryNotes ?? null,
		mapUrl: mapUrlForAddress(order?.deliveryAddress ?? '', order?.deliveryUnit ?? null),
		cashDueCents: stop.cashDueCents,
		cashCollectedCents: stop.cashCollectedCents,
		tipCents: order?.tipCents ?? 0,
		currency: order?.currency ?? '',
		canCall,
	}
}

function runView(
	bundle: RunBundle,
	options: { canCall: CallAvailability; includeAddresses: boolean },
): DeliveryRunView {
	const { run, driver } = bundle
	return {
		id: run.id,
		status: run.status,
		locationId: run.locationId,
		driver: {
			staffId: run.driverStaffId,
			name: driver ? driverDisplayName(driver.firstName, driver.lastName) : '',
		},
		createdByKind: run.createdByKind,
		createdAt: run.createdAt,
		pickedUpAt: run.pickedUpAt,
		stops: bundle.stops.map((stop) => {
			const view = stopView(
				stop,
				bundle.orders.get(stop.orderId),
				options.canCall({
					guestPhone: bundle.orders.get(stop.orderId)?.contactPhone ?? null,
					driverPhone: driver?.phone ?? null,
				}),
			)
			return options.includeAddresses
				? view
				: { ...view, address: '', unit: null, notes: null, firstName: '', mapUrl: '' }
		}),
		position: isOpenRunStatus(run.status) ? bundle.position : null,
	}
}

/**
 * The manager's board: ready orders waiting, open runs (and runs with a problem
 * still to settle), and the drivers. Names and addresses go to managers only.
 */
export async function loadBoard(
	db: Writer,
	locationId: string,
	options: { canCall: CallAvailability },
): Promise<DeliveryBoard> {
	const [unassigned, drivers] = await Promise.all([
		loadUnassigned(db, locationId),
		listDrivers(db, locationId),
	])
	const open = await db
		.select()
		.from(deliveryRuns)
		.where(
			and(
				eq(deliveryRuns.locationId, locationId),
				inArray(deliveryRuns.status, ['assigned', 'on_the_road']),
			),
		)
		.orderBy(asc(deliveryRuns.createdAt))
	// A finished run with a stop still on a problem: a manager has to settle it.
	const problemRuns = await db
		.select({ run: deliveryRuns })
		.from(deliveryRunStops)
		.innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId))
		.where(
			and(
				eq(deliveryRuns.locationId, locationId),
				eq(deliveryRunStops.status, 'problem'),
				inArray(deliveryRuns.status, ['completed']),
			),
		)
	const runs = [...open, ...problemRuns.map((row) => row.run)]
	const unique = [...new Map(runs.map((run) => [run.id, run])).values()]
	const bundles = await bundleRuns(db, unique)
	return {
		locationId,
		unassigned,
		runs: bundles.map((bundle) =>
			runView(bundle, { canCall: options.canCall, includeAddresses: true }),
		),
		drivers,
	}
}

export async function loadDriverSelf(
	db: Writer,
	input: {
		staffId: string
		locationId: string
		manager: boolean
		canCall: CallAvailability
	},
): Promise<DriverSelf> {
	const driver = await isDeliveryDriver(db, input.staffId, input.locationId)
	const role: DriverSelf['role'] = input.manager
		? 'manager'
		: driver
			? 'driver'
			: 'none'
	if (!driver) {
		return {
			role,
			isDriver: false,
			unavailable: false,
			claimable: [],
			run: null,
		}
	}
	const away = (await unavailableIds(db)).has(input.staffId)
	const [open] = await db
		.select()
		.from(deliveryRuns)
		.where(
			and(
				eq(deliveryRuns.driverStaffId, input.staffId),
				inArray(deliveryRuns.status, ['assigned', 'on_the_road']),
			),
		)
		.orderBy(desc(deliveryRuns.createdAt))
		.limit(1)
	const [bundle] = open ? await bundleRuns(db, [open]) : []
	return {
		role,
		isDriver: true,
		unavailable: away,
		claimable: away ? [] : await loadUnassigned(db, input.locationId),
		run: bundle
			? runView(bundle, { canCall: input.canCall, includeAddresses: true })
			: null,
	}
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

async function addNotice(
	tx: Writer,
	input: {
		staffId: string
		kind: DeliveryNoticeKind
		runId: string | null
		orderNumbers: string[]
		now: number
	},
) {
	await tx.insert(deliveryDriverNotices).values({
		staffId: input.staffId,
		kind: input.kind,
		runId: input.runId,
		orderNumbers: input.orderNumbers.slice(0, 20).join(','),
		createdAt: input.now,
	})
}

export type DriverNotice = {
	id: string
	kind: DeliveryNoticeKind
	orderNumbers: string[]
	createdAt: number
}

/** The driver's unread notices, marked read by this call (one device reads them once). */
export async function takeDriverNotices(
	db: TenantDatabase,
	staffId: string,
	now = Date.now(),
): Promise<DriverNotice[]> {
	const rows = await db
		.select()
		.from(deliveryDriverNotices)
		.where(
			and(
				eq(deliveryDriverNotices.staffId, staffId),
				isNull(deliveryDriverNotices.readAt),
			),
		)
		.orderBy(asc(deliveryDriverNotices.createdAt))
		.limit(20)
	if (rows.length > 0) {
		await db
			.update(deliveryDriverNotices)
			.set({ readAt: now })
			.where(
				inArray(
					deliveryDriverNotices.id,
					rows.map((row) => row.id),
				),
			)
	}
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		orderNumbers: row.orderNumbers ? row.orderNumbers.split(',') : [],
		createdAt: row.createdAt,
	}))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function transact<T>(
	db: TenantDatabase,
	orgId: string,
	work: (tx: OrderTx) => Promise<DeliveryResult<T>>,
): Promise<DeliveryResult<T>> {
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() => runTenantTransaction(db, work)),
	)
}

async function openRunForUpdate(
	tx: Writer,
	runId: string,
): Promise<DeliveryRun | null> {
	const [run] = await tx
		.select()
		.from(deliveryRuns)
		.where(eq(deliveryRuns.id, runId))
		.limit(1)
	return run ?? null
}

/**
 * Sends ready delivery orders out as one run. A manager picks the driver; a
 * driver claims for themselves (`actor.kind === 'driver'`).
 */
export async function createRun(
	db: TenantDatabase,
	input: {
		orgId: string
		locationId: string
		driverStaffId: string
		orderIds: string[]
		actor: DeliveryActor
	},
): Promise<DeliveryResult<{ runId: string }>> {
	const orderIds = [...new Set(input.orderIds)]
	if (orderIds.length === 0 || orderIds.length > MAX_STOPS_PER_RUN) {
		return fail(422, 'invalid_orders')
	}
	const now = Date.now()
	try {
		return await transact(db, input.orgId, async (tx) => {
			if (!(await isDeliveryDriver(tx, input.driverStaffId, input.locationId))) {
				return fail(404, 'driver_not_found')
			}
			if ((await unavailableIds(tx)).has(input.driverStaffId)) {
				return fail(409, 'driver_unavailable')
			}
			const orders = await tx
				.select()
				.from(restaurantOrders)
				.where(
					and(
						inArray(restaurantOrders.id, orderIds),
						eq(restaurantOrders.orgId, input.orgId),
					),
				)
			if (orders.length !== orderIds.length) return fail(404, 'order_not_found')
			for (const order of orders) {
				if (
					order.locationId !== input.locationId ||
					order.fulfillment !== 'delivery'
				) {
					return fail(404, 'order_not_found')
				}
				if (order.status !== 'ready') return fail(409, 'order_not_ready')
			}
			const held = await tx
				.select({ orderId: deliveryRunStops.orderId })
				.from(deliveryRunStops)
				.where(
					and(
						inArray(deliveryRunStops.orderId, orderIds),
						inArray(deliveryRunStops.status, ['pending', 'picked_up', 'problem']),
					),
				)
			if (held.length > 0) return fail(409, 'order_already_assigned')
			const [run] = await tx
				.insert(deliveryRuns)
				.values({
					locationId: input.locationId,
					driverStaffId: input.driverStaffId,
					status: 'assigned',
					createdByKind: input.actor.kind,
					createdById: input.actor.id,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
			const ordered = orderIds.map((id) => orders.find((order) => order.id === id)!)
			await tx.insert(deliveryRunStops).values(
				ordered.map((order, index) => ({
					runId: run!.id,
					orderId: order.id,
					stopNo: index + 1,
					status: 'pending' as const,
					cashDueCents: cashDueFor(order),
					zoneId: order.deliveryZoneId ?? null,
					createdAt: now,
				})),
			)
			// A manager's assignment tells the driver; their own claim does not.
			if (input.actor.kind === 'manager') {
				await addNotice(tx, {
					staffId: input.driverStaffId,
					kind: 'assigned',
					runId: run!.id,
					orderNumbers: ordered.map((order) => order.number),
					now,
				})
			}
			return ok({ runId: run!.id })
		})
	} catch (error) {
		// Two managers at once: the unique index let only one stop hold the order.
		if (isUniqueViolation(error)) return fail(409, 'order_already_assigned')
		throw error
	}
}

/** Gives every stop that is still open on a run to another driver (both are told). */
export async function reassignRun(
	db: TenantDatabase,
	input: {
		orgId: string
		runId: string
		driverStaffId: string
		actor: DeliveryActor
		scope?: DeliveryScope
	},
): Promise<DeliveryResult<{ runId: string }>> {
	const now = Date.now()
	return transact(db, input.orgId, async (tx) => {
		const run = await openRunForUpdate(tx, input.runId)
		if (!run || !isOpenRunStatus(run.status) || !inScope(input.scope, run.locationId)) {
			return fail(404, 'run_not_found')
		}
		if (run.driverStaffId === input.driverStaffId) return ok({ runId: run.id })
		if (!(await isDeliveryDriver(tx, input.driverStaffId, run.locationId))) {
			return fail(404, 'driver_not_found')
		}
		if ((await unavailableIds(tx)).has(input.driverStaffId)) {
			return fail(409, 'driver_unavailable')
		}
		const stops = await tx
			.select({ number: restaurantOrders.number })
			.from(deliveryRunStops)
			.innerJoin(restaurantOrders, eq(restaurantOrders.id, deliveryRunStops.orderId))
			.where(
				and(
					eq(deliveryRunStops.runId, run.id),
					inArray(deliveryRunStops.status, ['pending', 'picked_up']),
				),
			)
		const numbers = stops.map((stop) => stop.number)
		await tx
			.update(deliveryRuns)
			.set({ driverStaffId: input.driverStaffId, updatedAt: now })
			.where(eq(deliveryRuns.id, run.id))
		// The old driver's shared position is no longer theirs to share.
		await tx
			.delete(deliveryRunPositions)
			.where(eq(deliveryRunPositions.runId, run.id))
		await addNotice(tx, {
			staffId: run.driverStaffId,
			kind: 'taken_away',
			runId: run.id,
			orderNumbers: numbers,
			now,
		})
		await addNotice(tx, {
			staffId: input.driverStaffId,
			kind: 'assigned',
			runId: run.id,
			orderNumbers: numbers,
			now,
		})
		return ok({ runId: run.id })
	})
}

/** Closes a run once no stop is still waiting or on the road; clears its position. */
async function finishRunIfDone(tx: Writer, runId: string, now: number) {
	const live = await tx
		.select({ id: deliveryRunStops.id })
		.from(deliveryRunStops)
		.where(
			and(
				eq(deliveryRunStops.runId, runId),
				inArray(deliveryRunStops.status, ['pending', 'picked_up']),
			),
		)
		.limit(1)
	if (live.length > 0) return
	const stops = await tx
		.select({ status: deliveryRunStops.status })
		.from(deliveryRunStops)
		.where(eq(deliveryRunStops.runId, runId))
	const status = stops.every((stop) => stop.status === 'released')
		? 'cancelled'
		: 'completed'
	await tx
		.update(deliveryRuns)
		.set(
			status === 'cancelled'
				? { status, cancelledAt: now, updatedAt: now }
				: { status, completedAt: now, updatedAt: now },
		)
		.where(
			and(
				eq(deliveryRuns.id, runId),
				inArray(deliveryRuns.status, ['assigned', 'on_the_road']),
			),
		)
	// No coordinate outlives the run it was for.
	await tx.delete(deliveryRunPositions).where(eq(deliveryRunPositions.runId, runId))
}

type StopAccess = { run: DeliveryRun; stop: DeliveryRunStop; order: RestaurantOrder }

async function loadStopFor(
	tx: Writer,
	stopId: string,
	actor: DeliveryActor,
	driverStaffId: string | null,
	scope?: DeliveryScope,
): Promise<DeliveryResult<StopAccess>> {
	const [stop] = await tx
		.select()
		.from(deliveryRunStops)
		.where(eq(deliveryRunStops.id, stopId))
		.limit(1)
	if (!stop) return fail(404, 'stop_not_found')
	const run = await openRunForUpdate(tx, stop.runId)
	if (!run) return fail(404, 'stop_not_found')
	// A driver reaches only their own run, and only while it is open. Another
	// driver's stop and an old run answer the same 404.
	if (actor.kind === 'driver') {
		if (run.driverStaffId !== driverStaffId || !isOpenRunStatus(run.status)) {
			return fail(404, 'stop_not_found')
		}
	} else if (!inScope(scope, run.locationId)) {
		return fail(404, 'stop_not_found')
	}
	const [order] = await tx
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, stop.orderId))
		.limit(1)
	if (!order) return fail(404, 'stop_not_found')
	return ok({ run, stop, order })
}

const actorStep = (actor: DeliveryActor) => stepActorFor(actor.origin, actor.id)

/** Locations a manager may act in: null is every one (an unlimited token). */
export type DeliveryScope = readonly string[] | null

const inScope = (scope: DeliveryScope | undefined, locationId: string) =>
	scope === undefined || scope === null || scope.includes(locationId)

/** The driver has the orders in hand: all the run's waiting stops at once. */
export async function pickUpRun(
	db: TenantDatabase,
	input: {
		orgId: string
		runId: string
		actor: DeliveryActor
		/** The driver's staff id; a manager passes null. */
		driverStaffId: string | null
		scope?: DeliveryScope
	},
): Promise<DeliveryResult<{ runId: string; pickedUp: number }>> {
	const queues = orderWriteQueues()
	const now = Date.now()
	const result = await transact(db, input.orgId, async (tx) => {
		const run = await openRunForUpdate(tx, input.runId)
		if (!run || !isOpenRunStatus(run.status)) return fail(404, 'run_not_found')
		if (input.actor.kind === 'driver' && run.driverStaffId !== input.driverStaffId) {
			return fail(404, 'run_not_found')
		}
		if (input.actor.kind === 'manager' && !inScope(input.scope, run.locationId)) {
			return fail(404, 'run_not_found')
		}
		const stops = await tx
			.select()
			.from(deliveryRunStops)
			.where(and(eq(deliveryRunStops.runId, run.id), eq(deliveryRunStops.status, 'pending')))
			.orderBy(asc(deliveryRunStops.stopNo))
		let pickedUp = 0
		for (const stop of stops) {
			const [order] = await tx
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, stop.orderId))
				.limit(1)
			// An order cancelled while it waited is not carried out.
			if (!order || order.status !== 'ready') {
				await tx
					.update(deliveryRunStops)
					.set({ status: 'released', releasedAt: now })
					.where(eq(deliveryRunStops.id, stop.id))
				continue
			}
			await tx
				.update(deliveryRunStops)
				.set({ status: 'picked_up', pickedUpAt: now })
				.where(eq(deliveryRunStops.id, stop.id))
			await recordOrderStep(
				tx,
				order.id,
				{ ...actorStep(input.actor), step: 'out_for_delivery' },
				now,
			)
			// "On its way": email everywhere, text where the guest asked and it is allowed.
			await queueOrderMessage(
				tx,
				order,
				'out_for_delivery',
				queues.messages.context(now),
			)
			pickedUp += 1
		}
		if (run.status === 'assigned' && pickedUp > 0) {
			await tx
				.update(deliveryRuns)
				.set({ status: 'on_the_road', pickedUpAt: now, updatedAt: now })
				.where(eq(deliveryRuns.id, run.id))
		}
		await finishRunIfDone(tx, run.id, now)
		return ok({ runId: run.id, pickedUp })
	})
	await settleOrderWriteQueues(input.orgId, queues)
	return result
}

/**
 * A stop was delivered: the order completes through the one status machine (so
 * the `delivered` step and the order's own rules apply), the guest is told, and
 * the cash the driver collected is recorded against them. A driver marks only
 * stops they picked up; a manager may do it on their behalf from any open state.
 */
export async function markStopDelivered(
	db: TenantDatabase,
	input: {
		orgId: string
		stopId: string
		actor: DeliveryActor
		driverStaffId: string | null
		cashCollectedCents?: number
		scope?: DeliveryScope
	},
): Promise<DeliveryResult<{ orderId: string; runDone: boolean }>> {
	const queues = orderWriteQueues()
	const now = Date.now()
	const result = await transact(db, input.orgId, async (tx) => {
		const access = await loadStopFor(
			tx,
			input.stopId,
			input.actor,
			input.driverStaffId,
			input.scope,
		)
		if (!access.ok) return access
		const { run, stop, order } = access.value
		if (stop.status === 'delivered') {
			return ok({ orderId: order.id, runDone: !isOpenRunStatus(run.status) })
		}
		if (stop.status === 'released') return fail(409, 'stop_released')
		if (input.actor.kind === 'driver' && stop.status !== 'picked_up') {
			return fail(409, 'not_picked_up')
		}
		const due = stop.cashDueCents
		const collected = input.cashCollectedCents ?? (due > 0 ? due : 0)
		if (due === 0 && collected > 0) return fail(422, 'no_cash_due')
		const paidInFull = due > 0 && collected >= due
		let completed: RestaurantOrder = order
		if (order.status === 'ready') {
			const applied = await applyOrderStatusPatchInTx(
				tx,
				order,
				{ status: 'completed', ...(paidInFull ? { markPaid: true } : {}) },
				{
					cancel: {
						mayRefund: false,
						origin: input.actor.origin === 'station' ? 'station' : 'operator',
						actorId: input.actor.id,
					},
					queues,
					now: new Date(now),
				},
			)
			if (!applied.result.ok) {
				return fail(409, applied.result.failure.code, applied.result.failure.message)
			}
			completed = applied.result.data
		} else if (order.status !== 'completed') {
			return fail(409, 'order_not_deliverable')
		}
		await tx
			.update(deliveryRunStops)
			.set({
				status: 'delivered',
				deliveredAt: now,
				deliveredByKind: input.actor.kind,
				cashCollectedCents: collected,
				pickedUpAt: stop.pickedUpAt ?? now,
			})
			.where(eq(deliveryRunStops.id, stop.id))
		await queueOrderMessage(tx, completed, 'delivered', queues.messages.context(now))
		if (run.status === 'assigned') {
			await tx
				.update(deliveryRuns)
				.set({ status: 'on_the_road', pickedUpAt: now, updatedAt: now })
				.where(eq(deliveryRuns.id, run.id))
		}
		await finishRunIfDone(tx, run.id, now)
		const [after] = await tx
			.select({ status: deliveryRuns.status })
			.from(deliveryRuns)
			.where(eq(deliveryRuns.id, run.id))
		return ok({ orderId: order.id, runDone: !isOpenRunStatus(after?.status ?? 'completed') })
	})
	await settleOrderWriteQueues(input.orgId, queues)
	return result
}

/** The driver could not deliver: the stop waits for a manager, the driver's screen moves on. */
export async function reportStopProblem(
	db: TenantDatabase,
	input: {
		orgId: string
		stopId: string
		kind: DeliveryProblemKindValue
		actor: DeliveryActor
		driverStaffId: string | null
		scope?: DeliveryScope
	},
): Promise<DeliveryResult<{ runDone: boolean }>> {
	const now = Date.now()
	return transact(db, input.orgId, async (tx) => {
		const access = await loadStopFor(
			tx,
			input.stopId,
			input.actor,
			input.driverStaffId,
			input.scope,
		)
		if (!access.ok) return access
		const { run, stop } = access.value
		if (stop.status === 'delivered' || stop.status === 'released') {
			return fail(409, 'stop_closed')
		}
		await tx
			.update(deliveryRunStops)
			.set({ status: 'problem', problemKind: input.kind, problemAt: now })
			.where(eq(deliveryRunStops.id, stop.id))
		await finishRunIfDone(tx, run.id, now)
		const [after] = await tx
			.select({ status: deliveryRuns.status })
			.from(deliveryRuns)
			.where(eq(deliveryRuns.id, run.id))
		return ok({ runDone: !isOpenRunStatus(after?.status ?? 'completed') })
	})
}

/** A manager takes a delivery back: the order is free to be assigned again. */
export async function releaseStop(
	db: TenantDatabase,
	input: {
		orgId: string
		stopId: string
		actor: DeliveryActor
		scope?: DeliveryScope
	},
): Promise<DeliveryResult<{ orderId: string }>> {
	const now = Date.now()
	return transact(db, input.orgId, async (tx) => {
		const access = await loadStopFor(tx, input.stopId, input.actor, null, input.scope)
		if (!access.ok) return access
		const { run, stop, order } = access.value
		if (stop.status === 'delivered') return fail(409, 'stop_delivered')
		if (stop.status === 'released') return ok({ orderId: order.id })
		await tx
			.update(deliveryRunStops)
			.set({ status: 'released', releasedAt: now })
			.where(eq(deliveryRunStops.id, stop.id))
		if (isOpenRunStatus(run.status)) {
			await addNotice(tx, {
				staffId: run.driverStaffId,
				kind: 'stop_released',
				runId: run.id,
				orderNumbers: [order.number],
				now,
			})
		}
		await finishRunIfDone(tx, run.id, now)
		return ok({ orderId: order.id })
	})
}

/** The driver's own position, shared on purpose; deleted with the run. */
export async function shareDriverPosition(
	db: TenantDatabase,
	input: {
		orgId: string
		driverStaffId: string
		lat: number
		lng: number
	},
): Promise<DeliveryResult<{ runId: string }>> {
	const now = Date.now()
	return transact(db, input.orgId, async (tx) => {
		const [run] = await tx
			.select()
			.from(deliveryRuns)
			.where(
				and(
					eq(deliveryRuns.driverStaffId, input.driverStaffId),
					inArray(deliveryRuns.status, ['assigned', 'on_the_road']),
				),
			)
			.orderBy(desc(deliveryRuns.createdAt))
			.limit(1)
		if (!run) return fail(404, 'run_not_found')
		await tx
			.insert(deliveryRunPositions)
			.values({ runId: run.id, lat: input.lat, lng: input.lng, updatedAt: now })
			.onConflictDoUpdate({
				target: deliveryRunPositions.runId,
				set: { lat: input.lat, lng: input.lng, updatedAt: now },
			})
		return ok({ runId: run.id })
	})
}

/** Stops the driver stops sharing (the toggle off): the point is deleted now. */
export async function clearDriverPosition(
	db: TenantDatabase,
	driverStaffId: string,
): Promise<void> {
	await db.delete(deliveryRunPositions).where(
		inArray(
			deliveryRunPositions.runId,
			db
				.select({ id: deliveryRuns.id })
				.from(deliveryRuns)
				.where(eq(deliveryRuns.driverStaffId, driverStaffId)),
		),
	)
}

/**
 * What the stop's masked call needs: the guest's phone and the driver's, read
 * server-side. Neither number is ever returned to a device.
 */
export async function loadStopCallParties(
	db: TenantDatabase,
	input: { stopId: string; driverStaffId: string },
): Promise<
	DeliveryResult<{ guestPhone: string | null; driverPhone: string | null; orderId: string }>
> {
	const [row] = await db
		.select({
			stop: deliveryRunStops,
			run: deliveryRuns,
			order: restaurantOrders,
			driverPhone: staffMembers.phone,
		})
		.from(deliveryRunStops)
		.innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId))
		.innerJoin(restaurantOrders, eq(restaurantOrders.id, deliveryRunStops.orderId))
		.innerJoin(staffMembers, eq(staffMembers.id, deliveryRuns.driverStaffId))
		.where(eq(deliveryRunStops.id, input.stopId))
		.limit(1)
	if (
		!row ||
		row.run.driverStaffId !== input.driverStaffId ||
		!isOpenRunStatus(row.run.status) ||
		row.stop.status === 'delivered' ||
		row.stop.status === 'released'
	) {
		return fail(404, 'stop_not_found')
	}
	return ok({
		guestPhone: row.order.contactPhone ?? null,
		driverPhone: row.driverPhone ?? null,
		orderId: row.order.id,
	})
}

/** Cash a driver collected, by driver, for stops delivered in a window (the shift report). */
export async function loadDeliveryCash(
	db: TenantDatabase,
	input: { fromMs: number; toMs: number; locationId?: string | null },
): Promise<
	Array<{
		driverStaffId: string
		driverName: string
		deliveries: number
		cashDueCents: number
		cashCollectedCents: number
	}>
> {
	const rows = await db
		.select({
			driverStaffId: deliveryRuns.driverStaffId,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			deliveries: sql<number>`count(*)`,
			due: sql<number>`coalesce(sum(${deliveryRunStops.cashDueCents}), 0)`,
			collected: sql<number>`coalesce(sum(${deliveryRunStops.cashCollectedCents}), 0)`,
		})
		.from(deliveryRunStops)
		.innerJoin(deliveryRuns, eq(deliveryRuns.id, deliveryRunStops.runId))
		.innerJoin(staffMembers, eq(staffMembers.id, deliveryRuns.driverStaffId))
		.where(
			and(
				eq(deliveryRunStops.status, 'delivered'),
				sql`${deliveryRunStops.deliveredAt} >= ${input.fromMs}`,
				sql`${deliveryRunStops.deliveredAt} <= ${input.toMs}`,
				input.locationId ? eq(deliveryRuns.locationId, input.locationId) : undefined,
				sql`${deliveryRunStops.cashDueCents} > 0`,
			),
		)
		.groupBy(deliveryRuns.driverStaffId)
	return rows.map((row) => ({
		driverStaffId: row.driverStaffId,
		driverName: driverDisplayName(row.firstName, row.lastName),
		deliveries: Number(row.deliveries),
		cashDueCents: Number(row.due),
		cashCollectedCents: Number(row.collected),
	}))
}

export { isOpenRunStatus }
