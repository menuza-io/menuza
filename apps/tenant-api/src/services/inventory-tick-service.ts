import { createHash } from 'node:crypto'
import {
	COUNT_OVERDUE_ALERT_AFTER_MS,
	inventoryNotifyDedupeKey,
	type InventoryNotifyEvent,
	type InventoryTickNotifyKind,
	type InventoryTickResult,
	MAX_PRICE_RISE_DISH_ENTRIES,
	type PriceRiseDishAlertEntry,
} from '@repo/inventory'
import {
	getTenantDb,
	invAlertLog,
	invCountSchedules,
	invCounts,
	invDeliveries,
	invItemPlaces,
	invItems,
	invOrders,
	invPrepLevels,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { forEachWithBudget } from '../lib/concurrency.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import {
	pruneInventoryIdempotencyKeys,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	type InventoryNotifyOutcome,
	postInventoryNotify,
} from '../lib/inventory-notify.ts'
import {
	closeStaleQuickCounts,
	materializeRuns,
	markOverdueAlerted,
	overdueRunsToAlert,
} from './inventory-count-schedules-service.ts'
import { locationClock } from './inventory-common.ts'
import { syncAutoSoldOut } from './inventory-auto-sold-out.ts'
import { generatePrep, getPrepPlan } from './inventory-prep-service.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	processInventoryOutbox,
	pruneInventoryOutbox,
} from './inventory-sales-service.ts'
import { loadLocationStock } from './inventory-items-service.ts'
import {
	deliverOrderApprovalAlert,
	listDueOrders,
} from './inventory-orders-service.ts'
import {
	findPriceRises,
	priceRiseDishesForRises,
	type PriceRiseRow,
} from './inventory-receiving-service.ts'
import { processDueRepeatOrders } from './inventory-repeat-orders-service.ts'
import { processRoutinesForOrg } from './inventory-routines-service.ts'
import { rotateOrgIds } from './loyalty-tick-service.ts'

/**
 * The inventory tick for one organization (hourly cron fan-out, the Durable
 * Object alarm, the Node interval): works out the alerts a manager should hear
 * about, records each one once in `inv_alert_log` (a unique key per thing
 * that can happen once, so an hourly tick never resends), and posts the ones
 * not yet taken to the App (`POST /resources/inventory/notify`), retrying
 * what the App could not take. Idempotent. Ids and counts only: no name, no
 * amount, ever.
 *
 * - `inventory_low_stock`: a daily digest per location, from the morning on,
 *   counting items below their level (only items with levels set).
 * - `inventory_count_review`: a count sent for review (key: the count id).
 * - `inventory_delivery_due`: open orders due today or overdue, once a day
 *   from the morning.
 * - `inventory_price_rise`: a delivery whose prices rose by more than 5% on
 *   some item in the last week (key: the delivery id).
 *
 * It never throws and every location and step is its own try: one that fails
 * is logged by id, counted in `errors` and tried again next tick.
 */

/** Digests and due-delivery alerts start from this local hour. */
export const INVENTORY_DIGEST_FROM_TIME = '07:00'
/** A pending alert is retried at this pace while the App cannot take it. */
export const INVENTORY_ALERT_RETRY_MS = 5 * 60 * 1000
/** After this long, or this many attempts, an alert is given up (the moment has passed). */
export const INVENTORY_ALERT_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000
export const INVENTORY_ALERT_MAX_ATTEMPTS = 40
const PRICE_RISE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const POST_BATCH = 100
const DEFAULT_BUDGET_MS = 50_000

export type InventoryTickOutcome = Required<
	Pick<
		InventoryTickResult,
		'needsFollowUp' | 'nextDueAt' | 'countOverdueAlerts' | 'countsNotFinished'
	>
> &
	InventoryTickResult

function emptyResult(): InventoryTickOutcome {
	return {
		alertsSent: 0,
		alertsDeferred: 0,
		alertsSkipped: 0,
		lowStockDigests: 0,
		countReviewAlerts: 0,
		deliveryDueAlerts: 0,
		priceRiseAlerts: 0,
		countOverdueAlerts: 0,
		countsNotFinished: 0,
		salesSettled: 0,
		errors: 0,
		needsFollowUp: false,
		nextDueAt: null,
	}
}

/** The App dedupes by this id: the same thing always hashes to the same value. */
export function inventoryAlertEventId(input: {
	orgId: string
	kind: InventoryTickNotifyKind
	locationId: string
	dedupeKey: string
}): string {
	return createHash('sha256')
		.update(
			inventoryNotifyDedupeKey({
				orgId: input.orgId,
				kind: input.kind,
				locationId: input.locationId,
				key: input.dedupeKey,
			}),
		)
		.digest('hex')
}

async function inventoryLocationIds(db: TenantDatabase): Promise<string[]> {
	const lists = await Promise.all([
		db.selectDistinct({ id: invItemPlaces.locationId }).from(invItemPlaces),
		db.selectDistinct({ id: invCounts.locationId }).from(invCounts),
		db.selectDistinct({ id: invOrders.locationId }).from(invOrders),
		db.selectDistinct({ id: invDeliveries.locationId }).from(invDeliveries),
		db.selectDistinct({ id: invPrepLevels.locationId }).from(invPrepLevels),
		db
			.selectDistinct({ id: invCountSchedules.locationId })
			.from(invCountSchedules),
	])
	return [...new Set(lists.flat().map((row) => row.id))].sort()
}

export async function runInventoryTickForOrg(
	orgId: string,
	options: {
		now?: number
		/** Posts an alert to the App (tests replace it). */
		post?: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
		/** Stops posting when `Date.now()` reaches this (the fan-out's budget). */
		deadline?: number
	} = {},
): Promise<InventoryTickOutcome> {
	const now = options.now ?? Date.now()
	const post = options.post ?? postInventoryNotify
	const deadline = options.deadline ?? Date.now() + DEFAULT_BUDGET_MS
	const result = emptyResult()
	try {
		const db = await getTenantDb(orgId)
		// Nothing inventory does can exist before an item was added.
		const anyItem = await db
			.select({ id: invItems.id })
			.from(invItems)
			.limit(1)
			.get()
		if (!anyItem) return result
		const flags = await getInventoryFlagState(orgId)
		const features = flags.features

		// ── Sales waiting to take stock out (used by sales) ──────────────────
		// Retried here when settling right after the sale failed. Flags that
		// cannot be read (or the node kill switch) leave the queue alone; flags
		// that are off close it without effect, so stock is not counted from
		// sales made while inventory was off.
		let salesFollowUp: number | null = null
		if (flags.status === 'on' || flags.status === 'off') {
			try {
				const sales = await processInventoryOutbox(orgId, { now })
				result.salesSettled += sales.processed
				result.errors += sales.failed
				if (sales.failed > 0 || sales.more) {
					salesFollowUp = sales.nextDueAt ?? now + INVENTORY_ALERT_RETRY_MS
				}
				await pruneInventoryOutbox(orgId, now)
				await pruneInventoryIdempotencyKeys(orgId, now)
			} catch (error) {
				result.errors += 1
				console.error('Inventory sales step failed', {
					orgId,
					...errorLogFields(error),
				})
			}
		}

		// Dishes off the menu by stock: catches up after an App outage and
		// gives back what stock no longer justifies.
		if (flags.status === 'on' || flags.status === 'off') {
			try {
				const sold = await syncAutoSoldOut(orgId, { now })
				if (sold.deferred) {
					salesFollowUp = Math.min(
						salesFollowUp ?? Number.MAX_SAFE_INTEGER,
						now + INVENTORY_ALERT_RETRY_MS,
					)
				}
				// A sold-out alert held for its 15-minute window (or not taken yet).
				if (sold.alertDueAt !== null) {
					salesFollowUp = Math.min(
						salesFollowUp ?? Number.MAX_SAFE_INTEGER,
						sold.alertDueAt,
					)
				}
			} catch (error) {
				result.errors += 1
				console.error('Inventory auto sold out step failed', {
					orgId,
					...errorLogFields(error),
				})
			}
		}

		// Alerts follow the flags (the App also drops what it must not send).
		if (!features.enabled) {
			if (salesFollowUp !== null) {
				result.needsFollowUp = true
				result.nextDueAt = salesFollowUp
			}
			return result
		}

		/**
		 * Records an alert once. A key already in the log is not recorded again:
		 * a sent one is counted as skipped, a pending one is retried below.
		 */
		const record = async (
			kind: InventoryTickNotifyKind,
			locationId: string,
			dedupeKey: string,
			count: () => Promise<number>,
		): Promise<boolean> => {
			const existing = await db
				.select({ status: invAlertLog.status })
				.from(invAlertLog)
				.where(
					and(
						eq(invAlertLog.kind, kind),
						eq(invAlertLog.locationId, locationId),
						eq(invAlertLog.dedupeKey, dedupeKey),
					),
				)
				.get()
			if (existing) {
				if (existing.status === 'sent') result.alertsSkipped += 1
				return false
			}
			const total = await count()
			if (total < 1) return false
			const inserted = await db
				.insert(invAlertLog)
				.values({
					kind,
					locationId,
					dedupeKey,
					count: Math.min(total, 10_000),
					status: 'pending',
					attempts: 0,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: invAlertLog.id })
			return inserted.length > 0
		}

		const step = async (
			name: string,
			locationId: string,
			run: () => Promise<void>,
		) => {
			try {
				await run()
			} catch (error) {
				result.errors += 1
				console.error('Inventory tick step failed', {
					orgId,
					locationId,
					step: name,
					...errorLogFields(error),
				})
			}
		}

		let locations: string[] = []
		try {
			locations = await inventoryLocationIds(db)
		} catch (error) {
			result.errors += 1
			console.error('Inventory tick could not list locations', {
				orgId,
				...errorLogFields(error),
			})
		}
		const risesByDeliveryKey = new Map<string, PriceRiseRow[]>()
		for (const locationId of locations) {
			let clock: Awaited<ReturnType<typeof locationClock>>
			try {
				clock = await locationClock(db, locationId, now)
			} catch (error) {
				result.errors += 1
				console.error('Inventory tick could not read a location', {
					orgId,
					locationId,
					...errorLogFields(error),
				})
				continue
			}
			const morning = clock.local.time >= INVENTORY_DIGEST_FROM_TIME

			if (morning) {
				await step('low_stock', locationId, async () => {
					if (
						await record(
							'inventory_low_stock',
							locationId,
							clock.date,
							async () => {
								const stock = await loadLocationStock(db, locationId)
								return stock.filter(
									(row) =>
										row.place !== null &&
										(row.place.orderBelowQuantity !== null ||
											row.place.fillUpToQuantity !== null) &&
										row.status !== 'ok',
								).length
							},
						)
					) {
						result.lowStockDigests += 1
					}
				})
				// The day's prep list is there when the kitchen opens: planned once
				// per location and day, from the morning on.
				if (features.prep) {
					await step('prep', locationId, async () => {
						const caller = {
							orgId,
							region: getNodeRegion(),
							actor: { kind: 'system' as const, id: null },
							locationIds: null,
							cost: false,
							purchasing: false,
						}
						const today = await getPrepPlan(db, {
							caller,
							locationId,
							now,
						})
						if (!today.generated && today.canGenerate) {
							await generatePrep(caller, { locationId })
						}
					})
				}
				await step('delivery_due', locationId, async () => {
					if (
						await record(
							'inventory_delivery_due',
							locationId,
							clock.date,
							async () =>
								(await listDueOrders(db, { locationId, date: clock.date }))
									.length,
						)
					) {
						result.deliveryDueAlerts += 1
					}
				})
			}

			await step('count_review', locationId, async () => {
				const waiting = await db
					.select({ id: invCounts.id })
					.from(invCounts)
					.where(
						and(
							eq(invCounts.locationId, locationId),
							eq(invCounts.status, 'in_review'),
						),
					)
					.orderBy(asc(invCounts.createdAt), asc(invCounts.id))
				for (const count of waiting) {
					if (
						await record(
							'inventory_count_review',
							locationId,
							count.id,
							async () => waiting.length,
						)
					) {
						result.countReviewAlerts += 1
					}
				}
			})

			// Scheduled counts (#490, #491): the day's runs are stored, a quick count
			// left open past its next time is closed as not finished, and a run still
			// not started an hour after it was due tells the manager once.
			await step('count_schedules', locationId, async () => {
				const runs = await withInventoryWrite(
					{ orgId, now, skipAutoSoldOut: true },
					async (tx) => {
						const stored = await materializeRuns(
							tx,
							locationId,
							clock.date,
							now,
						)
						result.countsNotFinished += await closeStaleQuickCounts(tx, {
							locationId,
							now,
						})
						return stored
					},
				)
				for (const run of await overdueRunsToAlert(db, { locationId, now })) {
					if (Date.now() >= deadline) {
						result.alertsDeferred += 1
						continue
					}
					const outcome = await post({
						orgId,
						eventId: createHash('sha256')
							.update(
								inventoryNotifyDedupeKey({
									orgId,
									kind: 'inventory_count_overdue',
									locationId,
									key: run.id,
								}),
							)
							.digest('hex'),
						kind: 'inventory_count_overdue',
						locationId,
						count: 1,
						countOverdue: {
							runId: run.id,
							countKind: run.kind,
							slot:
								run.slot === 'opening' || run.slot === 'close'
									? run.slot
									: 'custom',
							dueAt: run.dueAt,
							assigneeKind:
								run.assigneeKind === 'staff' || run.assigneeKind === 'member'
									? run.assigneeKind
									: null,
							assigneeId: run.assigneeId,
						},
					})
					if (outcome.status === 'retry') {
						result.alertsDeferred += 1
						continue
					}
					// Sent, or refused for good: the run never alerts twice.
					await markOverdueAlerted(db, run.id, now)
					if (outcome.status === 'delivered') {
						result.alertsSent += 1
						result.countOverdueAlerts += 1
					} else {
						result.errors += 1
					}
				}
				// Wake again when the next unstarted run turns overdue.
				for (const run of runs) {
					if (run.status !== 'due' || run.overdueAlertedAt !== null) continue
					const at = run.dueAt + COUNT_OVERDUE_ALERT_AFTER_MS
					if (at > now) {
						salesFollowUp = Math.min(
							salesFollowUp ?? Number.MAX_SAFE_INTEGER,
							at,
						)
					}
				}
			})

			await step('price_rise', locationId, async () => {
				const rises = await findPriceRises(db, {
					locationId,
					sinceMs: now - PRICE_RISE_WINDOW_MS,
				})
				const byDelivery = new Map<string, number>()
				for (const rise of rises) {
					byDelivery.set(
						rise.deliveryId,
						(byDelivery.get(rise.deliveryId) ?? 0) + 1,
					)
					const key = `${locationId}\0${rise.deliveryId}`
					const list = risesByDeliveryKey.get(key)
					if (list) list.push(rise)
					else risesByDeliveryKey.set(key, [rise])
				}
				for (const [deliveryId, items] of byDelivery) {
					if (
						await record(
							'inventory_price_rise',
							locationId,
							deliveryId,
							async () => items,
						)
					) {
						result.priceRiseAlerts += 1
					}
				}
			})
		}

		// ── Routines (#529): drafts and manager messages, on this same tick ───
		if (features.routines) {
			try {
				const routines = await processRoutinesForOrg(db, {
					orgId,
					now,
					post,
					deadline,
				})
				result.routineRuns = (result.routineRuns ?? 0) + routines.runs
				result.alertsSent += routines.alertsSent
				result.alertsDeferred += routines.alertsDeferred
				result.errors += routines.errors
			} catch (error) {
				result.errors += 1
				console.error('Inventory routines step failed', {
					orgId,
					...errorLogFields(error),
				})
			}
		}

		// ── Repeat orders: draft due schedules before supplier cut-off (#499) ─
		if (features.purchasing) {
			try {
				const repeatOutcome = await processDueRepeatOrders(db, {
					orgId,
					region: getNodeRegion(),
					now,
					post,
					deadline,
				})
				result.alertsSent += repeatOutcome.alertsSent
				result.alertsDeferred += repeatOutcome.alertsDeferred
				result.errors += repeatOutcome.errors
			} catch (error) {
				result.errors += 1
				console.error('Inventory repeat orders step failed', {
					orgId,
					...errorLogFields(error),
				})
			}
			// Retry pending order approval alerts (#500)
			try {
				const pendingApprovals = await db
					.select()
					.from(invOrders)
					.where(
						and(
							eq(invOrders.status, 'draft'),
							eq(invOrders.approvalStatus, 'waiting_approval'),
							eq(invOrders.approvalAlertStatus, 'pending'),
						),
					)
					.orderBy(asc(invOrders.approvalRequestedAt), asc(invOrders.id))
					.limit(POST_BATCH)
				for (const order of pendingApprovals) {
					const createdAt = order.approvalRequestedAt ?? order.updatedAt
					if (
						now - createdAt > INVENTORY_ALERT_GIVE_UP_MS ||
						order.approvalAlertAttempts >= INVENTORY_ALERT_MAX_ATTEMPTS
					) {
						await db
							.update(invOrders)
							.set({ approvalAlertStatus: 'sent', updatedAt: now })
							.where(eq(invOrders.id, order.id))
						result.errors += 1
						continue
					}
					if (Date.now() >= deadline) {
						result.alertsDeferred += 1
						continue
					}
					const outcome = await deliverOrderApprovalAlert(db, {
						orgId,
						order,
						now,
						post,
					})
					if (outcome.status === 'delivered') {
						result.alertsSent += 1
					} else if (outcome.status === 'retry') {
						result.alertsDeferred += 1
					} else {
						result.errors += 1
					}
				}
			} catch (error) {
				result.errors += 1
				console.error('Inventory order approval alerts step failed', {
					orgId,
					...errorLogFields(error),
				})
			}
		}

		// ── Hand the pending alerts to the App ────────────────────────────────
		const pending = await db
			.select()
			.from(invAlertLog)
			.where(eq(invAlertLog.status, 'pending'))
			.orderBy(asc(invAlertLog.createdAt), asc(invAlertLog.id))
			.limit(POST_BATCH)
		for (const row of pending) {
			if (
				now - row.createdAt > INVENTORY_ALERT_GIVE_UP_MS ||
				row.attempts >= INVENTORY_ALERT_MAX_ATTEMPTS
			) {
				// The moment has passed: stop retrying, keep the row as the record.
				await db
					.update(invAlertLog)
					.set({ status: 'sent', sentAt: null, updatedAt: now })
					.where(eq(invAlertLog.id, row.id))
				result.errors += 1
				console.error('Inventory alert given up', {
					orgId,
					alertId: row.id,
					kind: row.kind,
					attempts: row.attempts,
				})
				continue
			}
			if (Date.now() >= deadline) {
				result.alertsDeferred += 1
				continue
			}
			let overdueCount: number | undefined
			if (row.kind === 'inventory_delivery_due') {
				const due = await listDueOrders(db, {
					locationId: row.locationId,
					date: row.dedupeKey,
				})
				overdueCount = Math.min(
					due.filter((entry) => entry.order.expectedDate! < row.dedupeKey)
						.length,
					10_000,
				)
			}
			let priceRiseDishes: PriceRiseDishAlertEntry[] | undefined
			if (row.kind === 'inventory_price_rise') {
				const key = `${row.locationId}\0${row.dedupeKey}`
				const risesForDelivery =
					risesByDeliveryKey.get(key) ??
					(
						await findPriceRises(db, {
							locationId: row.locationId,
							sinceMs: row.createdAt - PRICE_RISE_WINDOW_MS,
						})
					).filter((rise) => rise.deliveryId === row.dedupeKey)
				if (risesForDelivery.length > 0) {
					const evaluated = await priceRiseDishesForRises(db, {
						locationId: row.locationId,
						rises: risesForDelivery,
						limit: MAX_PRICE_RISE_DISH_ENTRIES,
					})
					if (evaluated.length > 0) priceRiseDishes = evaluated
				}
			}
			const outcome = await post({
				orgId,
				eventId: inventoryAlertEventId({
					orgId,
					kind: row.kind,
					locationId: row.locationId,
					dedupeKey: row.dedupeKey,
				}),
				kind: row.kind,
				locationId: row.locationId,
				count: Math.min(Math.max(row.count, 1), 10_000),
				...(overdueCount !== undefined ? { overdueCount } : {}),
				...(priceRiseDishes ? { priceRiseDishes } : {}),
			})
			if (outcome.status === 'delivered') {
				await db
					.update(invAlertLog)
					.set({
						status: 'sent',
						sentAt: now,
						attempts: row.attempts + 1,
						updatedAt: now,
					})
					.where(eq(invAlertLog.id, row.id))
				result.alertsSent += 1
			} else if (outcome.status === 'retry') {
				await db
					.update(invAlertLog)
					.set({ attempts: row.attempts + 1, updatedAt: now })
					.where(eq(invAlertLog.id, row.id))
				result.alertsDeferred += 1
			} else {
				await db
					.update(invAlertLog)
					.set({
						status: 'sent',
						sentAt: null,
						attempts: row.attempts + 1,
						updatedAt: now,
					})
					.where(eq(invAlertLog.id, row.id))
				result.errors += 1
				console.error('Inventory alert refused by the App', {
					orgId,
					alertId: row.id,
					kind: row.kind,
					code: outcome.code,
				})
			}
		}
		// More than one batch waits: another pass is due.
		const more =
			pending.length === POST_BATCH
				? await db
						.select({ id: invAlertLog.id })
						.from(invAlertLog)
						.where(inArray(invAlertLog.status, ['pending']))
						.limit(1)
						.get()
				: undefined
		if (result.alertsDeferred > 0 || more) {
			result.needsFollowUp = true
			result.nextDueAt = now + INVENTORY_ALERT_RETRY_MS
		}
		if (salesFollowUp !== null) {
			result.needsFollowUp = true
			result.nextDueAt =
				result.nextDueAt === null
					? salesFollowUp
					: Math.min(result.nextDueAt, salesFollowUp)
		}
		const counts = {
			lowStockDigests: result.lowStockDigests,
			countReviewAlerts: result.countReviewAlerts,
			deliveryDueAlerts: result.deliveryDueAlerts,
			priceRiseAlerts: result.priceRiseAlerts,
			alertsSent: result.alertsSent,
			alertsDeferred: result.alertsDeferred,
			salesSettled: result.salesSettled,
		}
		if (result.errors > 0) {
			console.error('Inventory tick needs attention', {
				orgId,
				...counts,
				errors: result.errors,
			})
		} else if (Object.values(counts).some((value) => value > 0)) {
			console.info('Inventory tick', { orgId, ...counts })
		}
		return result
	} catch (error) {
		result.errors += 1
		console.error('Inventory tick failed', { orgId, ...errorLogFields(error) })
		return result
	}
}

/** The per-organization half of a fan-out: a failing organization is logged and counted, never thrown. */
export async function runInventoryTickLogged(
	orgId: string,
	options: { deadline?: number } = {},
): Promise<InventoryTickOutcome | null> {
	try {
		return await runInventoryTickForOrg(orgId, options)
	} catch (error) {
		console.error(
			'Inventory tick failed for organization',
			orgId,
			errorLogFields(error),
		)
		return null
	}
}

export type InventoryTickAggregate = Omit<
	InventoryTickOutcome,
	'needsFollowUp' | 'nextDueAt'
> & { orgs: number; orgsDeferred: number }

export function emptyInventoryAggregate(): InventoryTickAggregate {
	const {
		needsFollowUp: _needsFollowUp,
		nextDueAt: _nextDueAt,
		...totals
	} = emptyResult()
	return { ...totals, orgs: 0, orgsDeferred: 0 }
}

/**
 * Runs the tick for many organizations with bounded concurrency and a time
 * budget (50 seconds): the walk starts at a different organization each hour,
 * and one not reached waits for a later run (`orgsDeferred`). Counts only.
 */
export async function fanOutInventoryTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<InventoryTickOutcome | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
	rotateBucket?: number
}): Promise<InventoryTickAggregate> {
	const now = options.now ?? Date.now
	const total = emptyInventoryAggregate()
	const orgIds = rotateOrgIds(
		options.orgIds,
		options.rotateBucket ?? Math.floor(now() / (60 * 60 * 1000)),
	)
	const run = await forEachWithBudget(
		orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors += 1
				return
			}
			total.orgs += 1
			total.alertsSent += result.alertsSent
			total.alertsDeferred += result.alertsDeferred
			total.alertsSkipped += result.alertsSkipped
			total.lowStockDigests += result.lowStockDigests
			total.countReviewAlerts += result.countReviewAlerts
			total.deliveryDueAlerts += result.deliveryDueAlerts
			total.priceRiseAlerts += result.priceRiseAlerts
			total.salesSettled += result.salesSettled
			total.errors += result.errors
		},
	)
	total.orgsDeferred = run.skipped
	if (run.skipped > 0) {
		console.warn('Inventory tick ran out of time', {
			orgs: total.orgs,
			errors: total.errors,
			orgsDeferred: total.orgsDeferred,
		})
	}
	return total
}
