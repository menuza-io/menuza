import {
	getTenantDb,
	marketingJourneys,
	orderJourneyEmissions,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { runInBackground } from '../lib/background.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { countedOrdersSql, DAY_MS } from './marketing-orders.ts'

/**
 * Order journeys (#99): starts marketing journeys from what guests order.
 * Three triggers, each firing once:
 *
 * - `order_first_placed`: a guest's first counted order (emission ref `first`).
 *   A first Station sale linked to the guest counts.
 * - `order_completed`: a counted order that is finished (ref = the order).
 *   A journey may ask for "only the Nth" order of the guest's.
 * - `guest_lapsed`: a guest who ordered before and has been quiet for the
 *   journey's number of days (ref = journey + last order time, so it fires once
 *   per quiet spell and re-arms after the next order). Runs in the regional
 *   tick, never per request.
 *
 * What counts as an order is `countedOrdersSql`: paid online or accepted at
 * pickup; cancelled and fully refunded orders never fire, and a fired trigger
 * is never undone. Orders with no linked guest fire nothing.
 *
 * Idempotency: `(customer, trigger, ref)` in `order_journey_emissions` is
 * claimed BEFORE the journey is started (`pending`), promoted to `fired` once
 * the start succeeded, dropped when it failed (so the next pass retries) and
 * retried when a `pending` claim went stale (a crash). Two concurrent orders
 * cannot start the same journey twice: only the claim's winner starts it.
 *
 * Consent is the journey step's business (`no_consent`): a trigger starts a run
 * for anyone, and a step only sends to guests who agreed.
 */

/** Orders older than this never start a journey (turning a journey on is not retroactive). */
export const ORDER_TRIGGER_WINDOW_MS = 2 * DAY_MS
/** Most guests one pass starts; the rest wait for the next pass. */
export const ORDER_JOURNEY_BATCH = 50
/** A `pending` claim older than this is a start that never finished. */
export const EMISSION_PENDING_STALE_MS = 5 * 60_000
/** A lapsed guest is started only while the quiet spell is this much longer than the journey's days. */
export const LAPSED_GRACE_DAYS = 30
export const DEFAULT_LAPSED_DAYS = 60

type JourneySpawner = (
	...args: Parameters<
		typeof import('./journey-service.ts').evaluateAndSpawnTriggers
	>
) => Promise<unknown>

let spawner: JourneySpawner | null = null

/** For tests: replaces the journey starter (`null` restores the real one). */
export function setOrderJourneySpawner(next: JourneySpawner | null): void {
	spawner = next
}

/**
 * The real starter is imported when used: the journey service reaches the order
 * service through its own imports, and a static import would close that loop.
 */
export async function spawnJourneys(...args: Parameters<JourneySpawner>) {
	if (spawner) return spawner(...args)
	const { evaluateAndSpawnTriggers } = await import('./journey-service.ts')
	return evaluateAndSpawnTriggers(...args)
}

/**
 * Claims one emission. True when this caller won it: nobody has it, or the one
 * holding it never finished (stale `pending`). False: already fired or in
 * flight elsewhere.
 */
export async function claimEmission(
	db: TenantDatabase,
	key: { customerId: string; trigger: string; ref: string },
	now: number,
): Promise<boolean> {
	const inserted = await retryOnSqliteBusy(() =>
		db
			.insert(orderJourneyEmissions)
			.values({ ...key, state: 'pending', emittedAt: now })
			.onConflictDoNothing()
			.returning({ ref: orderJourneyEmissions.ref }),
	)
	if (inserted.length > 0) return true
	const reclaimed = await db
		.update(orderJourneyEmissions)
		.set({ emittedAt: now })
		.where(
			and(
				eq(orderJourneyEmissions.customerId, key.customerId),
				eq(orderJourneyEmissions.trigger, key.trigger),
				eq(orderJourneyEmissions.ref, key.ref),
				eq(orderJourneyEmissions.state, 'pending'),
				lt(orderJourneyEmissions.emittedAt, now - EMISSION_PENDING_STALE_MS),
			),
		)
		.returning({ ref: orderJourneyEmissions.ref })
	return reclaimed.length > 0
}

/** Promotes a claim to `fired`, or drops it so the next pass retries the start. */
export async function settleEmission(
	db: TenantDatabase,
	key: { customerId: string; trigger: string; ref: string },
	started: boolean,
	now: number,
): Promise<void> {
	const where = and(
		eq(orderJourneyEmissions.customerId, key.customerId),
		eq(orderJourneyEmissions.trigger, key.trigger),
		eq(orderJourneyEmissions.ref, key.ref),
		eq(orderJourneyEmissions.state, 'pending'),
	)
	if (started) {
		await retryOnSqliteBusy(() =>
			db
				.update(orderJourneyEmissions)
				.set({ state: 'fired', emittedAt: now })
				.where(where),
		)
	} else {
		await retryOnSqliteBusy(() =>
			db.delete(orderJourneyEmissions).where(where),
		)
	}
}

/** Records an emission as already fired without starting anything (history, or nothing listening). */
async function recordFired(
	db: TenantDatabase,
	key: { customerId: string; trigger: string; ref: string },
	now: number,
) {
	await retryOnSqliteBusy(() =>
		db
			.insert(orderJourneyEmissions)
			.values({ ...key, state: 'fired', emittedAt: now })
			.onConflictDoNothing(),
	)
}

type ListeningJourney = {
	id: string
	triggerConfig: unknown
	publishedAt: Date | null
}

async function listening(
	db: TenantDatabase,
	trigger: string,
): Promise<ListeningJourney[]> {
	return db
		.select({
			id: marketingJourneys.id,
			triggerConfig: marketingJourneys.triggerConfig,
			publishedAt: marketingJourneys.publishedAt,
		})
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				eq(marketingJourneys.triggerType, trigger as 'order_completed'),
			),
		)
		.all()
}

/**
 * Orders older than the oldest listening journey's publish time never start it:
 * turning a journey on is not retroactive. A journey without a publish time
 * (should not happen) falls back to the recent window.
 */
function listenSince(journeys: ListeningJourney[], windowStart: number): number {
	const published = journeys
		.map((journey) => journey.publishedAt?.getTime())
		.filter((ms): ms is number => typeof ms === 'number')
	return published.length === journeys.length && published.length > 0
		? Math.max(windowStart, Math.min(...published))
		: windowStart
}

const inFlight = new Set<Promise<void>>()

/**
 * Evaluates order journeys in the background, after a write that made an order
 * count or complete. The sale that caused it never waits for it. The pass looks
 * at recent counted orders that have not been looked at yet, so it does not
 * matter which order triggered it, and the hourly tick covers a missed one.
 */
export function scheduleOrderJourneys(orgId: string): void {
	const work: Promise<void> = evaluateOrderJourneys(orgId)
		.then(() => undefined)
		.finally(() => {
			inFlight.delete(work)
		})
	inFlight.add(work)
	// On Workers `waitUntil` keeps the isolate alive until the starts finish.
	runInBackground(work)
}

/** Resolves once every background evaluation has finished (tests and shutdown). */
export async function orderJourneysIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}

type RecentOrder = {
	customer_id: string
	ts: number
	order_ref: string
	location_id: string
	completed: number
}

/**
 * One pass: first-order and order-completed journeys for recent counted
 * orders. Never throws; ids and codes only in the log.
 */
export async function evaluateOrderJourneys(
	orgId: string,
	options: { now?: number } = {},
): Promise<{ started: number }> {
	const now = options.now ?? Date.now()
	let started = 0
	try {
		const db = await getTenantDb(orgId)
		const since = now - ORDER_TRIGGER_WINDOW_MS
		started += await firstOrders(db, orgId, since, now)
		started += await completedOrders(db, orgId, since, now)
	} catch (error) {
		console.error('Order journeys could not be evaluated', {
			orgId,
			...errorLogFields(error),
		})
	}
	return { started }
}

async function startJourneys(
	db: TenantDatabase,
	orgId: string,
	trigger: 'order_first_placed' | 'order_completed' | 'guest_lapsed',
	key: { customerId: string; ref: string },
	context: Record<string, unknown>,
	now: number,
	options: { journeyId?: string } = {},
): Promise<boolean> {
	const emission = { customerId: key.customerId, trigger, ref: key.ref }
	if (!(await claimEmission(db, emission, now))) return false
	try {
		await spawnJourneys(
			orgId,
			trigger,
			key.customerId,
			undefined,
			context,
			options,
		)
	} catch (error) {
		console.error('Order journey could not start', {
			orgId,
			trigger,
			...errorLogFields(error),
		})
		await settleEmission(db, emission, false, now).catch(() => {})
		return false
	}
	await settleEmission(db, emission, true, now)
	return true
}

/** Counted orders in the window that nobody has looked at for this trigger yet. */
async function unseenOrders(
	db: TenantDatabase,
	trigger: string,
	since: number,
	completedOnly: boolean,
): Promise<RecentOrder[]> {
	return db.all<RecentOrder>(sql`
		SELECT o.customer_id, o.ts, o.order_ref, o.location_id, o.completed
		FROM ${countedOrdersSql()} o
		WHERE o.ts >= ${since}
			${completedOnly ? sql`AND o.completed = 1` : sql``}
			AND NOT EXISTS (
				SELECT 1 FROM order_journey_emissions e
				WHERE e.customer_id = o.customer_id AND e.trigger = ${trigger}
					AND (e.ref = o.order_ref OR (${trigger} = 'order_first_placed' AND e.ref = 'first'))
					AND (e.state = 'fired' OR e.emitted_at >= ${Date.now() - EMISSION_PENDING_STALE_MS})
			)
		ORDER BY o.ts ASC
		LIMIT ${ORDER_JOURNEY_BATCH * 4}`)
}

/** How many counted orders the guest had up to and including this one (ties broken by reference). */
async function orderSequence(
	db: TenantDatabase,
	customerId: string,
	ts: number,
	ref: string,
): Promise<number> {
	const rows = await db.all<{ n: number }>(sql`
		SELECT COUNT(*) AS n FROM ${countedOrdersSql()} o
		WHERE o.customer_id = ${customerId}
			AND (o.ts < ${ts} OR (o.ts = ${ts} AND o.order_ref <= ${ref}))`)
	return Number(rows[0]?.n ?? 0)
}

async function firstOrders(
	db: TenantDatabase,
	orgId: string,
	since: number,
	now: number,
): Promise<number> {
	const journeys = await listening(db, 'order_first_placed')
	// Nothing listening: nothing is read or written for orders.
	if (journeys.length === 0) return 0
	const orders = await unseenOrders(
		db,
		'order_first_placed',
		listenSince(journeys, since),
		false,
	)
	const seen = new Set<string>()
	let started = 0
	for (const order of orders) {
		if (seen.has(order.customer_id)) continue
		seen.add(order.customer_id)
		if (started >= ORDER_JOURNEY_BATCH) break
		try {
			const key = { customerId: order.customer_id, ref: 'first' }
			const sequence = await orderSequence(
				db,
				order.customer_id,
				order.ts,
				order.order_ref,
			)
			// Not the guest's first order (they ordered before): remember it so the
			// guest is never looked at again, and start nothing.
			if (sequence !== 1) {
				await recordFired(db, { ...key, trigger: 'order_first_placed' }, now)
				continue
			}
			if (
				await startJourneys(
					db,
					orgId,
					'order_first_placed',
					key,
					{ locationId: order.location_id, orderSequence: 1 },
					now,
				)
			) {
				started += 1
			}
		} catch (error) {
			// One guest never stops the rest; the next pass looks again.
			console.error('Order journey could not be evaluated for a guest', {
				orgId,
				...errorLogFields(error),
			})
		}
	}
	return started
}

async function completedOrders(
	db: TenantDatabase,
	orgId: string,
	since: number,
	now: number,
): Promise<number> {
	const journeys = await listening(db, 'order_completed')
	if (journeys.length === 0) return 0
	const orders = await unseenOrders(
		db,
		'order_completed',
		listenSince(journeys, since),
		true,
	)
	let started = 0
	for (const order of orders) {
		if (started >= ORDER_JOURNEY_BATCH) break
		try {
			const key = { customerId: order.customer_id, ref: order.order_ref }
			const sequence = await orderSequence(
				db,
				order.customer_id,
				order.ts,
				order.order_ref,
			)
			if (
				await startJourneys(
					db,
					orgId,
					'order_completed',
					key,
					{ locationId: order.location_id, orderSequence: sequence },
					now,
				)
			) {
				started += 1
			}
		} catch (error) {
			console.error('Order journey could not be evaluated for an order', {
				orgId,
				...errorLogFields(error),
			})
		}
	}
	return started
}

/**
 * The tick's part (#99): guests who ordered before and have been quiet for a
 * journey's number of days start that journey, once per quiet spell. Each
 * active `guest_lapsed` journey has its own `days` (default 60). A guest is
 * started only while the quiet spell is within `LAPSED_GRACE_DAYS` of the
 * threshold, so turning a journey on does not message everyone who ever left.
 */
export async function runLapsedJourneys(
	orgId: string,
	options: { now?: number } = {},
): Promise<{ started: number }> {
	const now = options.now ?? Date.now()
	let started = 0
	try {
		const db = await getTenantDb(orgId)
		const journeys = await listening(db, 'guest_lapsed')
		for (const journey of journeys) {
			const config =
				journey.triggerConfig && typeof journey.triggerConfig === 'object'
					? (journey.triggerConfig as { days?: unknown })
					: safeConfig(journey.triggerConfig)
			const days =
				typeof config.days === 'number' && config.days >= 1
					? Math.min(Math.floor(config.days), 3650)
					: DEFAULT_LAPSED_DAYS
			const quietBefore = now - days * DAY_MS
			const dormantBefore = now - (days + LAPSED_GRACE_DAYS) * DAY_MS
			const candidates = await db.all<{
				customer_id: string
				last_ts: number
			}>(sql`
				SELECT g.customer_id AS customer_id, g.last_ts AS last_ts FROM (
					SELECT o.customer_id AS customer_id, MAX(o.ts) AS last_ts
					FROM ${countedOrdersSql()} o GROUP BY o.customer_id
				) g
				WHERE g.last_ts <= ${quietBefore} AND g.last_ts >= ${dormantBefore}
					AND NOT EXISTS (
						SELECT 1 FROM order_journey_emissions e
						WHERE e.customer_id = g.customer_id AND e.trigger = 'guest_lapsed'
							AND e.ref = ${journey.id} || ':' || CAST(g.last_ts AS TEXT)
							AND (e.state = 'fired' OR e.emitted_at >= ${now - EMISSION_PENDING_STALE_MS})
					)
				ORDER BY g.last_ts ASC
				LIMIT ${ORDER_JOURNEY_BATCH}`)
			for (const row of candidates) {
				const ok = await startJourneys(
					db,
					orgId,
					'guest_lapsed',
					{
						customerId: row.customer_id,
						ref: `${journey.id}:${row.last_ts}`,
					},
					{ lapsedDays: days },
					now,
					{ journeyId: journey.id },
				)
				if (ok) started += 1
			}
		}
	} catch (error) {
		console.error('Lapsed journeys could not run', {
			orgId,
			...errorLogFields(error),
		})
	}
	return { started }
}

function safeConfig(raw: unknown): { days?: unknown } {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
		return parsed && typeof parsed === 'object'
			? (parsed as { days?: unknown })
			: {}
	} catch {
		return {}
	}
}

/** Drops old fired claims so the table stays small; a quiet spell older than this cannot fire again anyway. */
export async function pruneOrderEmissions(
	orgId: string,
	options: { now?: number } = {},
): Promise<void> {
	const now = options.now ?? Date.now()
	try {
		const db = await getTenantDb(orgId)
		await db
			.delete(orderJourneyEmissions)
			.where(
				and(
					inArray(orderJourneyEmissions.trigger, [
						'order_completed',
						'cart_left_behind',
					]),
					lt(orderJourneyEmissions.emittedAt, now - 120 * DAY_MS),
				),
			)
	} catch (error) {
		console.error('Order emissions could not be pruned', {
			orgId,
			...errorLogFields(error),
		})
	}
}
