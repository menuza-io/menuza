import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import {
	DUE_SOON_MINUTES,
	ORDER_ALERT_HOURS_MARGIN_MS,
	STATION_ALERT_HOURS_MARGIN_MS,
	STATION_CRITICAL_REPEAT_MS,
	STATION_OFFLINE_AFTER_MS,
	WAITING_GROUP_WINDOW_MS,
	isSpareTablet,
	type OrdersAlertSettings,
	type OrdersNotifyEvent,
} from '@repo/common/operator-alerts'
import {
	getTenantDb,
	orderAlerts,
	posDevices,
	restaurantOrders,
	type RestaurantOrder,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { runInBackground } from '../lib/background.ts'
import { inJsonList } from '../lib/chunked-in.ts'
import {
	fetchOrdersAlertSettings,
	isOrdersAlertsEnabled,
	postOrdersNotify,
	withinOpenHours,
} from '../lib/orders-alerts.ts'

/**
 * Manager alerts about orders and tablets (#131, #241, #300, #190), the region
 * half. Everything here is an id, an order number, a count, a time or a total;
 * the event contract (`ordersNotifyEventSchema`) is strict, so a guest's name,
 * phone, address, notes or items cannot be put in one.
 *
 * - `placed` is queued in the order's own transaction (`order_alerts`, unique
 *   per order and kind) and posted after commit; the tick retries it.
 * - The tick finds orders left New too long, scheduled orders due soon, payments
 *   to review, scheduled large orders about to start, and Station tablets that
 *   went silent or came back. One alert per order per kind: a row in
 *   `order_alerts` is the claim, written before the event is posted and taken
 *   back only when the App could not be reached.
 * - `ORDERS_ALERTS_ENABLED=false` drops everything (rows are marked `dropped`),
 *   so switching it back on sends no backlog.
 */

type Db = TenantDatabase | TenantTransaction

/**
 * Runs database work under the organization's order lock, the one every order
 * write holds. A write from here (after an order commits, or from the tick) on
 * another connection, while an order transaction is open, makes that
 * transaction fail on the shared SQLite file; the lock serializes them. A caller
 * that already holds the lock (re-entry) is serialized already and just runs.
 * `order-service` is imported lazily: it imports this module.
 */
async function locked<T>(orgId: string, work: () => Promise<T>): Promise<T> {
	const { runExclusive } = await import('./order-service.ts')
	try {
		return await runExclusive(orgId, work)
	} catch (error) {
		if (error instanceof Error && error.name === 'OrgLockReentryError') {
			return work()
		}
		throw error
	}
}

/** Orders a person has not started yet: "New" (and waiting for acceptance). */
export const WAITING_ORDER_STATUSES = [
	'accepted',
	'pending_acceptance',
] as const

const MINUTE = 60_000
const RETRY_BACKOFF_MS = [30_000, 60_000, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE]
const MAX_ATTEMPTS = 8
/** Orders examined per kind and pass. */
const BATCH = 200

type OrderForAlert = Pick<
	RestaurantOrder,
	| 'id'
	| 'fulfillment'
	| 'tabId'
	| 'tableId'
	| 'paymentMethod'
	| 'paymentStatus'
	| 'status'
	| 'locationId'
>

/** An online pickup or delivery order that stands (paid, free or pay at handoff). */
export function isAlertableOrder(order: OrderForAlert): boolean {
	return (
		order.fulfillment !== 'dine_in' &&
		!order.tabId &&
		!order.tableId &&
		(order.paymentMethod === 'handoff' ||
			order.paymentStatus === 'paid' ||
			order.paymentStatus === 'not_required') &&
		(WAITING_ORDER_STATUSES as readonly string[]).includes(order.status)
	)
}

const STANDS = sql`(${restaurantOrders.paymentMethod} = 'handoff' or ${restaurantOrders.paymentStatus} in ('paid', 'not_required'))`

const ONLINE_WAITING = and(
	inArray(restaurantOrders.status, [...WAITING_ORDER_STATUSES]),
	ne(restaurantOrders.fulfillment, 'dine_in'),
	isNull(restaurantOrders.tabId),
	isNull(restaurantOrders.tableId),
	STANDS,
)

// ---------------------------------------------------------------------------
// New order: queued with the order, posted after commit
// ---------------------------------------------------------------------------

export type OrderAlertContext = {
	now: number
	/** Receives the ids of rows queued to post, for delivery after commit. */
	collectAlert?: (id: string) => void
}

/**
 * Inside the order's transaction: queues the "new order" alert for an order
 * that stands (paid, free or pay at handoff). One row per order, so a second
 * call (a retried payment event) queues nothing. With the kill switch off the
 * row is written `dropped`, never held.
 */
export async function queueOrderPlacedAlert(
	tx: Db,
	order: OrderForAlert,
	ctx: OrderAlertContext,
): Promise<void> {
	if (!isAlertableOrder(order)) return
	const dropped = !isOrdersAlertsEnabled()
	const [row] = await tx
		.insert(orderAlerts)
		.values({
			orderId: order.id,
			kind: 'placed',
			locationId: order.locationId,
			status: dropped ? 'dropped' : 'pending',
			nextAttemptAt: ctx.now,
			createdAt: ctx.now,
		})
		.onConflictDoNothing()
		.returning({ id: orderAlerts.id })
	if (row && !dropped) ctx.collectAlert?.(row.id)
}

function dishCount(order: Pick<RestaurantOrder, 'lines'>): number {
	const lines = Array.isArray(order.lines)
		? (order.lines as Array<{ quantity?: unknown }>)
		: []
	return lines.reduce(
		(total, line) =>
			total +
			(typeof line.quantity === 'number' && line.quantity > 0
				? Math.floor(line.quantity)
				: 0),
		0,
	)
}

function placedEvent(orgId: string, order: RestaurantOrder): OrdersNotifyEvent {
	return {
		kind: 'order_placed',
		orgId,
		eventId: order.id,
		locationId: order.locationId,
		orderNumber: order.number,
		fulfillment: order.fulfillment === 'delivery' ? 'delivery' : 'pickup',
		scheduledForMs: order.scheduledFor ? order.scheduledFor.getTime() : null,
		totalCents: order.totalCents,
		currency: order.currency.toUpperCase(),
		dishCount: dishCount(order),
		large: order.largeOrder === true,
	}
}

function backoff(attempts: number): number {
	return RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]!
}

/**
 * Posts the queued "new order" rows by id (after commit) and, in the tick, the
 * due ones. Three steps so the network is never reached while the order lock is
 * held: read what to send, post it, then record how each went.
 */
export async function postQueuedPlacedAlerts(
	orgId: string,
	db: TenantDatabase,
	options: { ids?: readonly string[]; now?: number } = {},
): Promise<{ sent: number; retry: number }> {
	const now = options.now ?? Date.now()
	const prepared = await locked(orgId, async () => {
		const rows = await db
			.select()
			.from(orderAlerts)
			.where(
				and(
					eq(orderAlerts.status, 'pending'),
					inArray(orderAlerts.kind, ['placed']),
					options.ids
						? inJsonList(orderAlerts.id, [...options.ids])
						: lte(orderAlerts.nextAttemptAt, now),
				),
			)
			.orderBy(asc(orderAlerts.createdAt))
			.limit(BATCH)
		const out: Array<{
			row: (typeof rows)[number]
			event: OrdersNotifyEvent | null
		}> = []
		for (const row of rows) {
			if (!isOrdersAlertsEnabled()) {
				out.push({ row, event: null })
				continue
			}
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, row.orderId))
				.limit(1)
			// An order that was cancelled before the alert went out is not news.
			const gone =
				!order || order.status === 'cancelled' || order.status === 'expired'
			out.push({ row, event: gone ? null : placedEvent(orgId, order) })
		}
		return out
	})

	const results: Array<{
		row: (typeof prepared)[number]['row']
		outcome: 'delivered' | 'retry' | 'rejected' | 'dropped'
	}> = []
	for (const { row, event } of prepared) {
		if (!event) {
			results.push({ row, outcome: 'dropped' })
			continue
		}
		const posted = await postOrdersNotify(event)
		results.push({ row, outcome: posted.status })
	}

	let sent = 0
	let retry = 0
	await locked(orgId, async () => {
		for (const { row, outcome } of results) {
			if (outcome === 'delivered') {
				sent++
				await db
					.update(orderAlerts)
					.set({ status: 'sent', sentAt: now, attempts: row.attempts + 1 })
					.where(eq(orderAlerts.id, row.id))
			} else if (
				outcome === 'dropped' ||
				outcome === 'rejected' ||
				row.attempts + 1 >= MAX_ATTEMPTS
			) {
				await db
					.update(orderAlerts)
					.set({ status: 'dropped', attempts: row.attempts + 1 })
					.where(eq(orderAlerts.id, row.id))
			} else {
				retry++
				await db
					.update(orderAlerts)
					.set({
						attempts: row.attempts + 1,
						nextAttemptAt: now + backoff(row.attempts),
					})
					.where(eq(orderAlerts.id, row.id))
			}
		}
	})
	return { sent, retry }
}

/**
 * After the order's transaction: posts the alerts it queued, in the background,
 * never delaying or failing the response (the tick retries what is left). Then
 * checks the kitchen: an order that arrives while every kitchen tablet of its
 * location is offline is told about at once.
 */
export function deliverOrderAlerts(
	orgId: string,
	ids: readonly string[],
): void {
	if (ids.length === 0) return
	runInBackground(
		(async () => {
			try {
				const db = await getTenantDb(orgId)
				await postQueuedPlacedAlerts(orgId, db, { ids })
				await alertKitchenOffline(orgId, db, Date.now())
			} catch (error) {
				console.warn(
					'Order alerts not sent after commit',
					orgId,
					error instanceof Error ? error.name : 'unknown',
				)
			}
		})(),
	)
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export type OrderAlertsTickResult = {
	waiting: number
	dueSoon: number
	paymentReview: number
	largeSoon: number
	placedSent: number
	tabletsOffline: number
	tabletsBack: number
	kitchenOffline: number
	/** When the next piece of work is due (epoch ms), for the next alarm. */
	nextDueAt: number | null
}

const NOTHING: OrderAlertsTickResult = {
	waiting: 0,
	dueSoon: 0,
	paymentReview: 0,
	largeSoon: 0,
	placedSent: 0,
	tabletsOffline: 0,
	tabletsBack: 0,
	kitchenOffline: 0,
	nextDueAt: null,
}

function earliest(...values: Array<number | null>): number | null {
	const present = values.filter((value): value is number => value !== null)
	return present.length > 0 ? Math.min(...present) : null
}

/** Claims `orderIds` for `kind` (one alert per order per kind); returns the ones this call won. */
async function claim(
	orgId: string,
	db: Db,
	kind:
		| 'waiting'
		| 'due_soon'
		| 'payment_review'
		| 'large_soon'
		| 'kitchen_offline',
	rows: ReadonlyArray<{ id: string; locationId: string }>,
	now: number,
): Promise<string[]> {
	return locked(orgId, async () => {
		const won: string[] = []
		for (const row of rows) {
			const [claimed] = await db
				.insert(orderAlerts)
				.values({
					orderId: row.id,
					kind,
					locationId: row.locationId,
					status: 'sent',
					nextAttemptAt: now,
					createdAt: now,
					sentAt: now,
					lastSentAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: orderAlerts.id })
			if (claimed) won.push(row.id)
		}
		return won
	})
}

/** Takes a claim back when the App could not be reached, so the next tick tries again. */
async function release(
	orgId: string,
	db: Db,
	kind: 'waiting' | 'due_soon' | 'payment_review' | 'large_soon',
	orderIds: readonly string[],
) {
	if (orderIds.length === 0) return
	await locked(orgId, () =>
		db
			.delete(orderAlerts)
			.where(
				and(
					eq(orderAlerts.kind, kind),
					inJsonList(orderAlerts.orderId, [...orderIds]),
				),
			),
	)
}

type Candidate = Pick<
	RestaurantOrder,
	'id' | 'number' | 'locationId' | 'createdAt' | 'paidAt' | 'scheduledFor'
>

const candidateColumns = {
	id: restaurantOrders.id,
	number: restaurantOrders.number,
	locationId: restaurantOrders.locationId,
	createdAt: restaurantOrders.createdAt,
	paidAt: restaurantOrders.paidAt,
	scheduledFor: restaurantOrders.scheduledFor,
}

function newSince(order: Candidate): number {
	return (order.paidAt ?? order.createdAt)?.getTime() ?? 0
}

function noAlertYet(kind: string) {
	return sql`not exists (select 1 from ${orderAlerts} where ${orderAlerts.orderId} = ${restaurantOrders.id} and ${orderAlerts.kind} = ${kind})`
}

function locationMap(settings: OrdersAlertSettings) {
	return new Map(settings.locations.map((location) => [location.id, location]))
}

/**
 * The orders and tablets tick for one organization (#131, #300, #190): runs with
 * the guest messages and acceptance tick (hourly cron, Durable Object alarm,
 * Node interval). Asks the App what the organization may alert about; with the
 * flag off or the kill switch off it alerts nothing and holds nothing back.
 */
export async function runOrderAlertsTickForOrg(
	orgId: string,
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<OrderAlertsTickResult> {
	const now = options.now ?? Date.now()
	const db = options.db ?? (await getTenantDb(orgId))

	if (!isOrdersAlertsEnabled()) {
		// Dropped, never held: nothing is sent when the switch comes back on.
		await locked(orgId, () =>
			db
				.update(orderAlerts)
				.set({ status: 'dropped' })
				.where(eq(orderAlerts.status, 'pending')),
		)
		return { ...NOTHING }
	}
	const settings = await fetchOrdersAlertSettings(orgId, now)
	// The App cannot be asked: try again soon; nothing is alerted blind.
	if (!settings) return { ...NOTHING, nextDueAt: now + 2 * MINUTE }
	if (!settings.enabled) {
		await locked(orgId, () =>
			db
				.update(orderAlerts)
				.set({ status: 'dropped' })
				.where(eq(orderAlerts.status, 'pending')),
		)
		return { ...NOTHING }
	}
	const locations = locationMap(settings)
	const result: OrderAlertsTickResult = { ...NOTHING }

	const posted = await postQueuedPlacedAlerts(orgId, db, { now })
	result.placedSent = posted.sent
	let nextDue: number | null = null
	const pending = await db
		.select({ at: sql<number | null>`min(${orderAlerts.nextAttemptAt})` })
		.from(orderAlerts)
		.where(eq(orderAlerts.status, 'pending'))
	if (pending[0]?.at) nextDue = Number(pending[0].at)

	// Waiting longer than the location allows: one alert per location, with every
	// order that crossed the line (or will within five minutes) in it.
	for (const location of locations.values()) {
		const threshold = location.waitingMinutes * MINUTE
		const window = withinOpenHours(
			location.openIntervals,
			now,
			ORDER_ALERT_HOURS_MARGIN_MS,
		)
		const rows = (await db
			.select(candidateColumns)
			.from(restaurantOrders)
			.where(
				and(
					ONLINE_WAITING,
					eq(restaurantOrders.locationId, location.id),
					isNull(restaurantOrders.scheduledFor),
					noAlertYet('waiting'),
				),
			)
			.orderBy(asc(restaurantOrders.createdAt))
			.limit(BATCH)) as Candidate[]
		if (rows.length === 0) continue
		const oldest = rows[0]!
		const crossesAt = newSince(oldest) + threshold
		if (crossesAt > now) {
			nextDue = earliest(nextDue, crossesAt)
			continue
		}
		// Outside opening hours plus an hour (no hours set: any time, an order that
		// just arrived is its own proof someone is there): nothing, tried again.
		if (window === 'outside') continue
		const group = rows.filter(
			(order) => newSince(order) + threshold <= now + WAITING_GROUP_WINDOW_MS,
		)
		// Orders further from the line than five minutes get their own alert later.
		const later = rows.filter((order) => !group.includes(order))
		if (later.length > 0) {
			nextDue = earliest(nextDue, newSince(later[0]!) + threshold)
		}
		const won = await claim(orgId, db, 'waiting', group, now)
		if (won.length === 0) continue
		const numbers = group
			.filter((order) => won.includes(order.id))
			.map((order) => order.number)
			.slice(0, 20)
		const outcome = await postOrdersNotify({
			kind: 'orders_waiting',
			orgId,
			eventId: `waiting:${group.find((o) => won.includes(o.id))!.id}`,
			locationId: location.id,
			orderNumbers: numbers,
		})
		if (outcome.status === 'retry') {
			await release(orgId, db, 'waiting', won)
			nextDue = earliest(nextDue, now + backoff(0))
		} else if (outcome.status === 'delivered') {
			result.waiting += won.length
		}
	}

	// Scheduled orders due within 15 minutes and still New.
	for (const location of locations.values()) {
		const window = withinOpenHours(
			location.openIntervals,
			now,
			ORDER_ALERT_HOURS_MARGIN_MS,
		)
		const rows = (await db
			.select(candidateColumns)
			.from(restaurantOrders)
			.where(
				and(
					ONLINE_WAITING,
					eq(restaurantOrders.locationId, location.id),
					sql`${restaurantOrders.scheduledFor} is not null`,
					noAlertYet('due_soon'),
				),
			)
			.orderBy(asc(restaurantOrders.scheduledFor))
			.limit(BATCH)) as Candidate[]
		if (rows.length === 0) continue
		const dueAt = (order: Candidate) => order.scheduledFor!.getTime()
		const first = rows[0]!
		const startsAlerting = dueAt(first) - DUE_SOON_MINUTES * MINUTE
		if (startsAlerting > now) {
			nextDue = earliest(nextDue, startsAlerting)
			continue
		}
		// An order whose time has long passed is the waiting alert's business.
		if (window === 'outside') continue
		const group = rows.filter(
			(order) => dueAt(order) - DUE_SOON_MINUTES * MINUTE <= now,
		)
		const later = rows.filter((order) => !group.includes(order))
		if (later.length > 0) {
			nextDue = earliest(nextDue, dueAt(later[0]!) - DUE_SOON_MINUTES * MINUTE)
		}
		const won = await claim(orgId, db, 'due_soon', group, now)
		if (won.length === 0) continue
		const claimed = group.filter((order) => won.includes(order.id))
		const outcome = await postOrdersNotify({
			kind: 'orders_due_soon',
			orgId,
			eventId: `due-soon:${claimed[0]!.id}`,
			locationId: location.id,
			orderNumbers: claimed.map((order) => order.number).slice(0, 20),
			dueAtMs: dueAt(claimed[0]!),
		})
		if (outcome.status === 'retry') {
			await release(orgId, db, 'due_soon', won)
			nextDue = earliest(nextDue, now + backoff(0))
		} else if (outcome.status === 'delivered') {
			result.dueSoon += won.length
		}
	}

	// A payment that needs a person to look at it (always on).
	const reviews = (await db
		.select(candidateColumns)
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.status, 'payment_review'),
				ne(restaurantOrders.fulfillment, 'dine_in'),
				isNull(restaurantOrders.tabId),
				noAlertYet('payment_review'),
			),
		)
		.orderBy(asc(restaurantOrders.createdAt))
		.limit(BATCH)) as Candidate[]
	for (const order of reviews) {
		const [won] = await claim(orgId, db, 'payment_review', [order], now)
		if (!won) continue
		const outcome = await postOrdersNotify({
			kind: 'orders_payment_review',
			orgId,
			eventId: `payment-review:${order.id}`,
			locationId: order.locationId,
			orderNumber: order.number,
		})
		if (outcome.status === 'retry') {
			await release(orgId, db, 'payment_review', [order.id])
			nextDue = earliest(nextDue, now + backoff(0))
		} else if (outcome.status === 'delivered') {
			result.paymentReview++
		}
	}

	// A scheduled large order, a set time before it starts (#300).
	for (const location of locations.values()) {
		if (!location.largeOrder) continue
		const remindMs = location.largeOrder.remindMinutes * MINUTE
		const rows = (await db
			.select({
				...candidateColumns,
				totalCents: restaurantOrders.totalCents,
				currency: restaurantOrders.currency,
				fulfillment: restaurantOrders.fulfillment,
				lines: restaurantOrders.lines,
			})
			.from(restaurantOrders)
			.where(
				and(
					ONLINE_WAITING,
					eq(restaurantOrders.locationId, location.id),
					eq(restaurantOrders.largeOrder, true),
					sql`${restaurantOrders.scheduledFor} is not null`,
					noAlertYet('large_soon'),
				),
			)
			.orderBy(asc(restaurantOrders.scheduledFor))
			.limit(BATCH)) as Array<
			Candidate &
				Pick<
					RestaurantOrder,
					'totalCents' | 'currency' | 'fulfillment' | 'lines'
				>
		>
		for (const order of rows) {
			const at = order.scheduledFor!.getTime()
			if (at - remindMs > now) {
				nextDue = earliest(nextDue, at - remindMs)
				continue
			}
			// Past its start time: too late to be "soon".
			if (at < now - 5 * MINUTE) continue
			const [won] = await claim(orgId, db, 'large_soon', [order], now)
			if (!won) continue
			const outcome = await postOrdersNotify({
				kind: 'large_order_soon',
				orgId,
				eventId: `large-soon:${order.id}`,
				locationId: order.locationId,
				orderNumber: order.number,
				fulfillment: order.fulfillment === 'delivery' ? 'delivery' : 'pickup',
				scheduledForMs: at,
				totalCents: order.totalCents,
				currency: order.currency.toUpperCase(),
				dishCount: dishCount(order),
			})
			if (outcome.status === 'retry') {
				await release(orgId, db, 'large_soon', [order.id])
				nextDue = earliest(nextDue, now + backoff(0))
			} else if (outcome.status === 'delivered') {
				result.largeSoon++
			}
		}
	}

	const tablets = await runStationHealth(orgId, db, settings, now)
	result.tabletsOffline = tablets.offline
	result.tabletsBack = tablets.back
	nextDue = earliest(nextDue, tablets.nextDueAt)
	result.kitchenOffline = await alertKitchenOffline(orgId, db, now, settings)
	result.nextDueAt = nextDue
	return result
}

// ---------------------------------------------------------------------------
// Station tablets (#190)
// ---------------------------------------------------------------------------

type DeviceRow = {
	id: string
	label: string
	locationId: string | null
	lastSeenAt: number | null
	lastHeartbeatAt: number | null
	offlineAlertedAt: number | null
	deviceSettings: string
}

async function loadWatchedDevices(db: Db): Promise<DeviceRow[]> {
	const rows = await db
		.select({
			id: posDevices.id,
			label: posDevices.label,
			locationId: posDevices.locationId,
			lastSeenAt: posDevices.lastSeenAt,
			lastHeartbeatAt: posDevices.lastHeartbeatAt,
			offlineAlertedAt: posDevices.offlineAlertedAt,
			deviceSettings: posDevices.deviceSettings,
		})
		.from(posDevices)
		.where(isNull(posDevices.revokedAt))
	return rows.filter((row) => !isSpareTablet(row.label))
}

function isOffline(device: DeviceRow, now: number): boolean {
	return (
		device.lastSeenAt !== null &&
		now - device.lastSeenAt >= STATION_OFFLINE_AFTER_MS
	)
}

/** Only a tablet that has sent an alert-era heartbeat is watched. */
function isWatched(device: DeviceRow): boolean {
	return device.lastHeartbeatAt !== null && device.lastSeenAt !== null
}

function kitchenStationOf(device: DeviceRow): string | null {
	try {
		const parsed = JSON.parse(device.deviceSettings) as {
			kdsStationId?: unknown
		}
		return typeof parsed.kdsStationId === 'string' && parsed.kdsStationId
			? parsed.kdsStationId
			: null
	} catch {
		return null
	}
}

/**
 * A tablet silent for five minutes during opening hours (plus half an hour) is
 * told about once per outage; the outage's start is stored (`offline_alerted_at`)
 * and cleared when the tablet returns, which sends a "back online" note. A
 * tablet that never connected, was removed or is called "spare" never alerts,
 * and a location with no opening hours is never called an outage (like #356).
 */
async function runStationHealth(
	orgId: string,
	db: TenantDatabase,
	settings: OrdersAlertSettings,
	now: number,
): Promise<{ offline: number; back: number; nextDueAt: number | null }> {
	const locations = locationMap(settings)
	const devices = (await loadWatchedDevices(db)).filter(isWatched)
	let offline = 0
	let back = 0
	let nextDue: number | null = null
	for (const device of devices) {
		const lastSeen = device.lastSeenAt!
		if (!isOffline(device, now)) {
			// Online. If it was in an alerted outage, it is back.
			if (
				device.offlineAlertedAt !== null &&
				lastSeen > device.offlineAlertedAt
			) {
				const minutes = Math.floor(
					(lastSeen - device.offlineAlertedAt) / MINUTE,
				)
				const outcome = await postOrdersNotify({
					kind: 'station_offline',
					orgId,
					eventId: `${device.id}:${device.offlineAlertedAt}:back`,
					locationId: device.locationId,
					deviceId: device.id,
					deviceLabel: device.label.slice(0, 60),
					state: 'back_online',
					minutes,
					allKitchenOffline: false,
					waitingOrderNumber: null,
				})
				if (outcome.status !== 'retry') {
					await locked(orgId, () =>
						db
							.update(posDevices)
							.set({ offlineAlertedAt: null })
							.where(eq(posDevices.id, device.id)),
					)
					back++
				}
			} else {
				nextDue = earliest(nextDue, lastSeen + STATION_OFFLINE_AFTER_MS)
			}
			continue
		}
		if (device.offlineAlertedAt !== null) continue
		const location = device.locationId ? locations.get(device.locationId) : null
		if (!location) continue
		const window = withinOpenHours(
			location.openIntervals,
			now,
			STATION_ALERT_HOURS_MARGIN_MS,
		)
		// Outside opening hours plus half an hour, or hours not set: not an outage.
		if (window !== 'inside') continue
		const outcome = await postOrdersNotify({
			kind: 'station_offline',
			orgId,
			eventId: `${device.id}:${lastSeen}`,
			locationId: location.id,
			deviceId: device.id,
			deviceLabel: device.label.slice(0, 60),
			state: 'offline',
			minutes: Math.floor((now - lastSeen) / MINUTE),
			allKitchenOffline: false,
			waitingOrderNumber: null,
		})
		if (outcome.status === 'retry') {
			nextDue = earliest(nextDue, now + backoff(0))
			continue
		}
		await locked(orgId, () =>
			db
				.update(posDevices)
				.set({ offlineAlertedAt: lastSeen })
				.where(eq(posDevices.id, device.id)),
		)
		if (outcome.status === 'delivered') offline++
	}
	return { offline, back, nextDueAt: nextDue }
}

/**
 * Every kitchen tablet of a location offline while an online order waits is
 * critical: told at once, and again every five minutes until the order is no
 * longer New. A location's kitchen tablets are the ones with a kitchen station
 * set (all its tablets when none has one); a tablet that never connected, was
 * removed or is "spare" does not count.
 */
export async function alertKitchenOffline(
	orgId: string,
	db: TenantDatabase,
	now: number,
	knownSettings?: OrdersAlertSettings | null,
): Promise<number> {
	if (!isOrdersAlertsEnabled()) return 0
	const settings = knownSettings ?? (await fetchOrdersAlertSettings(orgId, now))
	if (!settings?.enabled) return 0
	const devices = (await loadWatchedDevices(db)).filter(
		(device) => device.lastSeenAt !== null && device.locationId !== null,
	)
	const byLocation = new Map<string, DeviceRow[]>()
	for (const device of devices) {
		byLocation.set(device.locationId!, [
			...(byLocation.get(device.locationId!) ?? []),
			device,
		])
	}
	let sent = 0
	for (const [locationId, all] of byLocation) {
		const stationed = all.filter((device) => kitchenStationOf(device) !== null)
		const kitchen = stationed.length > 0 ? stationed : all
		if (
			kitchen.length === 0 ||
			!kitchen.every((device) => isOffline(device, now))
		) {
			continue
		}
		const oldest = (await db
			.select(candidateColumns)
			.from(restaurantOrders)
			.where(
				and(
					ONLINE_WAITING,
					eq(restaurantOrders.locationId, locationId),
					or(
						isNull(restaurantOrders.scheduledFor),
						lte(
							restaurantOrders.scheduledFor,
							new Date(now + DUE_SOON_MINUTES * MINUTE),
						),
					),
				),
			)
			.orderBy(asc(restaurantOrders.createdAt))
			.limit(1)) as Candidate[]
		const order = oldest[0]
		if (!order) continue
		// The first alert is the claim; repeats update it every five minutes.
		const [existing] = await db
			.select()
			.from(orderAlerts)
			.where(
				and(
					eq(orderAlerts.orderId, order.id),
					eq(orderAlerts.kind, 'kitchen_offline'),
				),
			)
			.limit(1)
		if (
			existing &&
			now - (existing.lastSentAt ?? 0) < STATION_CRITICAL_REPEAT_MS
		) {
			continue
		}
		if (!existing) {
			const [won] = await claim(orgId, db, 'kitchen_offline', [order], now)
			if (!won) continue
		} else {
			// Taken before the post: a concurrent tick sends nothing twice.
			const taken = await locked(orgId, () =>
				db
					.update(orderAlerts)
					.set({ lastSentAt: now })
					.where(
						and(
							eq(orderAlerts.id, existing.id),
							lte(orderAlerts.lastSentAt, now - STATION_CRITICAL_REPEAT_MS),
						),
					)
					.returning({ id: orderAlerts.id }),
			)
			if (taken.length === 0) continue
		}
		const device = kitchen[0]!
		const outcome = await postOrdersNotify({
			kind: 'station_offline',
			orgId,
			eventId: `kitchen-offline:${order.id}:${Math.floor(now / STATION_CRITICAL_REPEAT_MS)}`,
			locationId,
			deviceId: device.id,
			deviceLabel: 'Kitchen',
			state: 'offline',
			minutes: Math.floor((now - (device.lastSeenAt ?? now)) / MINUTE),
			allKitchenOffline: true,
			waitingOrderNumber: order.number,
		})
		if (outcome.status === 'delivered') sent++
	}
	return sent
}
