import { createHash, randomUUID } from 'node:crypto'
import {
	CUTOFF_REMINDER_MINUTES,
	inventoryNotifyDedupeKey,
	ROUTINE_KEYS,
	ROUTINE_MORNING_FROM_TIME,
	ROUTINE_TEMPLATES,
	type InventoryNotifyEvent,
	type Routine,
	type RoutineKey,
	type RoutineRun,
} from '@repo/inventory'
import { addDays, dayOfWeek } from '@repo/reservations'
import {
	getTenantDb,
	invCounts,
	invRoutineRuns,
	invRoutines,
	shifts,
	staffMembers,
	type InvRoutineRow,
	type InvRoutineRunRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne } from 'drizzle-orm'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { postInventoryNotify, type InventoryNotifyOutcome } from '../lib/inventory-notify.ts'
import {
	hashInventoryRequest,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { getNodeRegion } from '../lib/region.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	decodeCursor,
	encodeCursor,
	locationClock,
} from './inventory-common.ts'
import { listCountRuns } from './inventory-count-schedules-service.ts'
import { getFreshness } from './inventory-lots-service.ts'
import { type InventoryCaller, loadLocationStock } from './inventory-items-service.ts'
import {
	buildSuggestedOrders,
	createOrder,
	listDueOrders,
} from './inventory-orders-service.ts'
import { getPrepPlan } from './inventory-prep-service.ts'
import { loadDaysLeft } from './inventory-days-left.ts'
import { wasteSummary } from './inventory-waste-service.ts'

/**
 * Ready-made back-of-house routines (#529). Each routine is on or off per
 * location (`inv_routines`); the region's own tick runs the ones that are due
 * (no new cron slot) and the count routine also runs right after a count is
 * approved. A run is one row (`inv_routine_runs`, unique per location, routine
 * and run key, so it happens once) holding the summary, generated here in the
 * region. Routines DRAFT AND TELL only: an order is made as a draft, never sent
 * to a supplier, and the one message goes to a manager through the same
 * notification path as the other alerts (ids and a key, never the summary).
 */

const ALERT_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000
const ALERT_MAX_ATTEMPTS = 40
const ALERT_BATCH = 50
const LAST_RUNS = 5

type SummaryOf = Record<string, unknown>

function eventId(
	orgId: string,
	kind: 'inventory_routine' | 'inventory_repeat_order_draft',
	locationId: string,
	runId: string,
) {
	return createHash('sha256')
		.update(inventoryNotifyDedupeKey({ orgId, kind, locationId, key: runId }))
		.digest('hex')
}

const systemCaller = (orgId: string): InventoryCaller => ({
	orgId,
	region: getNodeRegion(),
	actor: { kind: 'system', id: null },
	locationIds: null,
	cost: false,
	purchasing: true,
})

// ── The page: templates, state and runs ─────────────────────────────────────

function runView(row: InvRoutineRunRow, cost: boolean): RoutineRun {
	const summary = { ...(row.summaryJson as SummaryOf) }
	if (!cost) {
		delete summary.valueMinor
		delete summary.currency
		if (Array.isArray(summary.topItems)) {
			summary.topItems = (summary.topItems as SummaryOf[]).map((item) => {
				const { valueMinor: _ignored, ...rest } = item
				return rest
			})
		}
	}
	return {
		id: row.id,
		locationId: row.locationId,
		runKey: row.runKey,
		status: row.status,
		alerted: row.alertStatus === 'sent',
		createdAt: row.createdAt,
		key: row.key,
		summary,
	} as RoutineRun
}

/** `GET /routines`: every template with its state at the location and its last runs. */
export async function listRoutines(
	db: TenantDatabase,
	input: { caller: InventoryCaller; locationId: string; purchasing: boolean },
): Promise<{ locationId: string; routines: Routine[] }> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const [rows, runs] = await Promise.all([
		db.select().from(invRoutines).where(eq(invRoutines.locationId, input.locationId)),
		db
			.select()
			.from(invRoutineRuns)
			.where(eq(invRoutineRuns.locationId, input.locationId))
			.orderBy(desc(invRoutineRuns.createdAt), desc(invRoutineRuns.id))
			.limit(200),
	])
	const byKey = new Map(rows.map((row) => [row.key, row]))
	return {
		locationId: input.locationId,
		routines: ROUTINE_KEYS.map((key) => {
			const row = byKey.get(key)
			return {
				key,
				enabled: row?.enabled ?? false,
				enabledAt: row?.enabledAt ?? null,
				version: row?.version ?? 0,
				blocked:
					ROUTINE_TEMPLATES[key].needsPurchasing && !input.purchasing
						? ('purchasing_off' as const)
						: null,
				lastRuns: runs
					.filter((run) => run.key === key)
					.slice(0, LAST_RUNS)
					.map((run) => runView(run, input.caller.cost)),
			}
		}),
	}
}

/** `GET /routines/runs`: every run of the location, newest first. */
export async function listRoutineRuns(
	db: TenantDatabase,
	input: {
		caller: InventoryCaller
		locationId: string
		key?: RoutineKey
		limit: number
		cursor?: string
	},
) {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const cursor = decodeCursor(input.cursor)
	const rows = await db
		.select()
		.from(invRoutineRuns)
		.where(
			and(
				eq(invRoutineRuns.locationId, input.locationId),
				input.key ? eq(invRoutineRuns.key, input.key) : undefined,
				cursor ? lt(invRoutineRuns.createdAt, cursor.sort) : undefined,
			),
		)
		.orderBy(desc(invRoutineRuns.createdAt), desc(invRoutineRuns.id))
		.limit(input.limit + 1)
	const page = rows.slice(0, input.limit)
	return {
		runs: page.map((row) => runView(row, input.caller.cost)),
		nextCursor:
			rows.length > input.limit
				? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
				: null,
	}
}

/** `PUT /routines/:key`: turn a routine on or off at a location. */
export async function setRoutine(
	caller: InventoryCaller,
	input: {
		key: RoutineKey
		locationId: string
		enabled: boolean
		expectedVersion: number
		purchasing: boolean
	},
): Promise<Routine> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	if (
		input.enabled &&
		ROUTINE_TEMPLATES[input.key].needsPurchasing &&
		!input.purchasing
	) {
		throw new InventoryError('feature_disabled', 403, { feature: 'purchasing' })
	}
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await tx
			.select()
			.from(invRoutines)
			.where(
				and(
					eq(invRoutines.locationId, input.locationId),
					eq(invRoutines.key, input.key),
				),
			)
			.get()
		assertVersion(row?.version ?? 0, input.expectedVersion)
		if (!row) {
			await tx.insert(invRoutines).values({
				locationId: input.locationId,
				key: input.key,
				enabled: input.enabled,
				enabledAt: input.enabled ? ctx.now : null,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
		} else {
			await tx
				.update(invRoutines)
				.set({
					enabled: input.enabled,
					// Turned on again: it counts from now, not from the old date.
					enabledAt: input.enabled && !row.enabled ? ctx.now : row.enabledAt,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invRoutines.id, row.id))
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: input.enabled ? 'routine.enable' : 'routine.disable',
			resourceType: 'routine',
			resourceId: input.key,
			locationId: input.locationId,
			at: ctx.now,
		})
	})
	const db = await getTenantDb(caller.orgId)
	const all = await listRoutines(db, {
		caller,
		locationId: input.locationId,
		purchasing: input.purchasing,
	})
	return all.routines.find((routine) => routine.key === input.key)!
}

// ── Running ─────────────────────────────────────────────────────────────────

type RunInput = {
	db: TenantDatabase
	orgId: string
	routine: InvRoutineRow
	now: number
	features: { purchasing: boolean; prep: boolean; recipes: boolean; useBy: boolean }
}

type RunResult = {
	runKey: string
	status: 'done' | 'nothing_to_do' | 'failed'
	summary: SummaryOf
	/** Tell a manager (with this kind). */
	notify: { kind: 'inventory_routine' | 'inventory_repeat_order_draft'; count: number } | null
}

async function insertRun(
	db: TenantDatabase,
	routine: InvRoutineRow,
	result: RunResult,
	now: number,
): Promise<InvRoutineRunRow | null> {
	const [row] = await db
		.insert(invRoutineRuns)
		.values({
			id: randomUUID(),
			routineId: routine.id,
			locationId: routine.locationId,
			key: routine.key,
			runKey: result.runKey,
			status: result.status,
			summaryJson: result.summary,
			alertStatus: result.notify ? 'pending' : 'sent',
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning()
	return row ?? null
}

async function runKeyExists(
	db: TenantDatabase,
	routine: InvRoutineRow,
	runKey: string,
): Promise<boolean> {
	const row = await db
		.select({ id: invRoutineRuns.id })
		.from(invRoutineRuns)
		.where(
			and(
				eq(invRoutineRuns.locationId, routine.locationId),
				eq(invRoutineRuns.key, routine.key),
				eq(invRoutineRuns.runKey, runKey),
			),
		)
		.get()
	return row !== undefined
}

/**
 * Low items after an approved count: one DRAFT per supplier that has something
 * to order and no draft yet. Nothing is sent. The orders are made through the
 * one order writer, keyed by the run, so a repeat makes none twice.
 */
async function runCountLowStock(
	input: RunInput,
	countId: string,
): Promise<RunResult> {
	const { db, orgId, routine, now } = input
	const base = { runKey: countId }
	if (!input.features.purchasing) {
		return {
			...base,
			status: 'nothing_to_do',
			summary: { countId, drafted: [], draftExisted: [], unsourced: 0, reason: 'purchasing_off' },
			notify: null,
		}
	}
	const suggestion = await buildSuggestedOrders(db, {
		locationId: routine.locationId,
		cost: false,
		now,
		recipes: input.features.recipes,
	})
	const drafted: Array<{ orderId: string; number: number; supplierName: string; lineCount: number }> = []
	const draftExisted: Array<{ supplierName: string; orderId: string }> = []
	for (const card of suggestion.suppliers) {
		if (card.lines.length === 0) continue
		if (card.draftOrderId) {
			draftExisted.push({ supplierName: card.supplierName, orderId: card.draftOrderId })
			continue
		}
		const clientKey = `routine:${countId}:${card.supplierId}`
		const body = {
			clientId: clientKey,
			locationId: routine.locationId,
			supplierId: card.supplierId,
			expectedDate: card.expectedDate,
			note: 'Drafted by the low stock routine after a count. Review before it goes out.',
			fromSuggestion: false,
			lines: card.lines.map((line) => ({
				itemId: line.itemId,
				supplierProductId: line.supplierProductId,
				packs: line.packs,
			})),
		}
		const created = await createOrder(systemCaller(orgId), {
			body,
			idempotency: {
				key: clientKey,
				scope: 'routine:count_low_stock',
				requestHash: hashInventoryRequest(body),
			},
		})
		drafted.push({
			orderId: created.id,
			number: created.number,
			supplierName: card.supplierName,
			lineCount: card.lines.length,
		})
	}
	return {
		...base,
		status: drafted.length > 0 ? 'done' : 'nothing_to_do',
		summary: {
			countId,
			drafted,
			draftExisted,
			unsourced: suggestion.unsourced.length,
			...(drafted.length === 0 && draftExisted.length === 0
				? { reason: 'no_low_items' }
				: {}),
		},
		// The manager reviews the drafts: the one message the repeat-order drafts use.
		notify: drafted.length > 0
			? { kind: 'inventory_repeat_order_draft', count: drafted.length }
			: null,
	}
}

/** The week before: top five items and the reasons. */
async function runWeeklyWaste(input: RunInput, date: string): Promise<RunResult> {
	const { db, routine } = input
	// The Monday morning covers the week that just ended (Monday to Sunday).
	const to = addDays(date, -1)
	const from = addDays(date, -7)
	const summary = await wasteSummary(db, {
		locationId: routine.locationId,
		from,
		to,
		cost: true,
	})
	return {
		runKey: date,
		status: summary.count > 0 ? 'done' : 'nothing_to_do',
		summary: {
			from,
			to,
			count: summary.count,
			...(summary.valueMinor !== undefined ? { valueMinor: summary.valueMinor } : {}),
			...(summary.currency ? { currency: summary.currency } : {}),
			topItems: summary.topItems.slice(0, 5).map((item) => ({
				itemId: item.itemId,
				itemName: item.itemName,
				count: item.count,
				...(item.valueMinor !== undefined ? { valueMinor: item.valueMinor } : {}),
			})),
			byReason: summary.byReason.map((row) => ({ reason: row.reason, count: row.count })),
		},
		notify: summary.count > 0 ? { kind: 'inventory_routine', count: summary.count } : null,
	}
}

/** Who is on a published shift today (shifts are tied to the location through its scope). */
async function workingToday(db: TenantDatabase, locationId: string, date: string) {
	const rows = await db
		.select({
			scopeId: shifts.scopeId,
			firstName: staffMembers.firstName,
			staffId: shifts.staffId,
		})
		.from(shifts)
		.innerJoin(staffMembers, eq(staffMembers.id, shifts.staffId))
		.where(
			and(
				eq(shifts.localDate, date),
				eq(shifts.status, 'published'),
				isNotNull(shifts.staffId),
				ne(shifts.status, 'cancelled'),
			),
		)
		.orderBy(asc(shifts.startsAt))
	const scopes = [...new Set(rows.map((row) => row.scopeId))]
	// The location's own scope; with one scope in the whole schedule, that one.
	const scope = scopes.includes(locationId)
		? locationId
		: scopes.length === 1
			? scopes[0]!
			: null
	if (scope === null) {
		return { known: rows.length === 0, staff: [] as Array<{ firstName: string }> }
	}
	const seen = new Set<string>()
	const staff: Array<{ firstName: string }> = []
	for (const row of rows) {
		if (row.scopeId !== scope || !row.staffId || seen.has(row.staffId)) continue
		seen.add(row.staffId)
		staff.push({ firstName: row.firstName })
		if (staff.length >= 20) break
	}
	return { known: true, staff }
}

/** Today in one message: deliveries, counts, prep, who is working, what runs out, and what to use first. */
async function runMorningBrief(input: RunInput, date: string, now: number): Promise<RunResult> {
	const { db, routine } = input
	const locationId = routine.locationId
	const caller = { ...systemCaller(input.orgId), features: { enabled: true, purchasing: input.features.purchasing, recipes: input.features.recipes, prep: input.features.prep, transfers: false, useBy: input.features.useBy } }
	const stock = await loadLocationStock(db, locationId)
	const [due, scheduled, openCount, daysLeft, working] = await Promise.all([
		input.features.purchasing
			? listDueOrders(db, { locationId, date })
			: Promise.resolve([]),
		listCountRuns(db, { locationId, date, now }),
		db
			.select({ id: invCounts.id })
			.from(invCounts)
			.where(
				and(
					eq(invCounts.locationId, locationId),
					inArray(invCounts.status, ['counting', 'in_review']),
				),
			)
			.limit(1)
			.get(),
		loadDaysLeft(db, { locationId, today: date, now, rows: stock }).catch(() => null),
		workingToday(db, locationId, date),
	])
	const prep = input.features.prep
		? await getPrepPlan(db, { caller, locationId, now }).catch(() => null)
		: null
	const fresh = input.features.useBy
		? await getFreshness(db, { locationId, caller, now }).catch(() => null)
		: null
	const soon = new Set<string>()
	if (daysLeft) {
		for (const [itemId, left] of daysLeft) {
			if (left.state === 'ok' && left.days < 3) soon.add(itemId)
		}
	}
	const runningOut = stock
		.filter((row) => !row.group.isGroup && row.place !== null)
		.flatMap((row) => {
			const status =
				row.status === 'out' ? 'out' : row.status === 'low' ? 'low' : soon.has(row.item.id) ? 'runs_out_soon' : null
			return status ? [{ itemId: row.item.id, itemName: row.item.name, status }] : []
		})
		.slice(0, 20)
	const summary = {
		date,
		deliveries: due.map(({ order, supplierName }) => ({
			orderId: order.id,
			supplierName,
			expectedDate: order.expectedDate!,
			overdue: order.expectedDate! < date,
		})),
		counts: {
			scheduled: scheduled.map((run) => ({
				countKind: run.kind,
				slot: run.slot,
				dueAt: run.dueAt,
			})),
			weekly: false,
			inProgress: openCount !== undefined,
		},
		prep: prep ? { tasks: prep.tasks.length } : null,
		working,
		runningOut,
		useBy: fresh
			? { expired: fresh.expiredCount, useFirst: fresh.useFirstCount }
			: null,
	}
	return {
		runKey: date,
		status: 'done',
		summary,
		notify: { kind: 'inventory_routine', count: 1 },
	}
}

/** A reminder: the supplier's cut-off is near and no order is drafted. */
async function runCutoffReminders(input: RunInput, now: number): Promise<RunResult[]> {
	const { db, routine } = input
	if (!input.features.purchasing) return []
	const clock = await locationClock(db, routine.locationId, now)
	const suggestion = await buildSuggestedOrders(db, {
		locationId: routine.locationId,
		cost: false,
		now,
		recipes: input.features.recipes,
	})
	const minutesNow =
		Number(clock.local.time.slice(0, 2)) * 60 + Number(clock.local.time.slice(3, 5))
	const out: RunResult[] = []
	for (const card of suggestion.suppliers) {
		if (!card.cutoff || card.cutoff.date !== clock.local.date) continue
		if (card.lineCount === 0 || card.draftOrderId) continue
		const cutoffMinutes =
			Number(card.cutoff.time.slice(0, 2)) * 60 + Number(card.cutoff.time.slice(3, 5))
		const left = cutoffMinutes - minutesNow
		if (left <= 0 || left > CUTOFF_REMINDER_MINUTES) continue
		out.push({
			runKey: `${card.cutoff.date}:${card.supplierId}`,
			status: 'done',
			summary: {
				supplierId: card.supplierId,
				supplierName: card.supplierName,
				cutoffDate: card.cutoff.date,
				cutoffTime: card.cutoff.time,
				itemCount: card.lineCount,
			},
			notify: { kind: 'inventory_routine', count: 1 },
		})
	}
	return out
}

export type RoutinesOutcome = {
	runs: number
	alertsSent: number
	alertsDeferred: number
	errors: number
}

/**
 * The count routine, right after a count is approved (and the tick, as a
 * backstop). Never throws: the approval is already committed.
 */
export async function runCountApprovedRoutine(
	orgId: string,
	countId: string,
	options: { now?: number; post?: (e: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome> } = {},
): Promise<void> {
	try {
		const db = await getTenantDb(orgId)
		const count = await db.select().from(invCounts).where(eq(invCounts.id, countId)).get()
		if (!count || count.status !== 'approved') return
		const flags = await getInventoryFlagState(orgId)
		if (flags.status !== 'on' || !flags.features.routines) return
		const routine = await db
			.select()
			.from(invRoutines)
			.where(
				and(
					eq(invRoutines.locationId, count.locationId),
					eq(invRoutines.key, 'count_low_stock'),
					eq(invRoutines.enabled, true),
				),
			)
			.get()
		if (!routine) return
		await processRoutinesForOrg(db, {
			orgId,
			now: options.now ?? Date.now(),
			post: options.post ?? postInventoryNotify,
			only: { key: 'count_low_stock', countId },
		})
	} catch {
		/* the tick runs it again */
	}
}

/**
 * One organization's routines for the tick: the count routine for approved
 * counts it has not run, the Monday waste summary, the morning brief, the
 * cut-off reminders, then the manager messages that are still pending.
 */
export async function processRoutinesForOrg(
	db: TenantDatabase,
	input: {
		orgId: string
		now: number
		post: (event: InventoryNotifyEvent) => Promise<InventoryNotifyOutcome>
		deadline?: number
		only?: { key: 'count_low_stock'; countId: string }
	},
): Promise<RoutinesOutcome> {
	const { orgId, now, post } = input
	const deadline = input.deadline ?? Date.now() + 20_000
	const outcome: RoutinesOutcome = { runs: 0, alertsSent: 0, alertsDeferred: 0, errors: 0 }
	const flags = await getInventoryFlagState(orgId)
	if (flags.status !== 'on' || !flags.features.routines) return outcome
	const features = {
		purchasing: flags.features.purchasing,
		prep: flags.features.prep,
		recipes: flags.features.recipes,
		useBy: flags.features.useBy === true,
	}
	const enabled = await db.select().from(invRoutines).where(eq(invRoutines.enabled, true))
	for (const routine of enabled) {
		if (Date.now() >= deadline) break
		if (input.only && routine.key !== input.only.key) continue
		const base = { db, orgId, routine, now, features }
		try {
			const clock = await locationClock(db, routine.locationId, now)
			const results: RunResult[] = []
			if (routine.key === 'count_low_stock') {
				const counts = input.only
					? [{ id: input.only.countId }]
					: await db
							.select({ id: invCounts.id })
							.from(invCounts)
							.where(
								and(
									eq(invCounts.locationId, routine.locationId),
									eq(invCounts.status, 'approved'),
									gte(invCounts.approvedAt, routine.enabledAt ?? now),
								),
							)
							.orderBy(asc(invCounts.approvedAt))
							.limit(10)
				for (const count of counts) {
					if (await runKeyExists(db, routine, count.id)) continue
					results.push(await runCountLowStock(base, count.id))
				}
			} else if (routine.key === 'weekly_waste') {
				if (dayOfWeek(clock.local.date) === 1 && clock.local.time >= ROUTINE_MORNING_FROM_TIME) {
					if (!(await runKeyExists(db, routine, clock.local.date))) {
						results.push(await runWeeklyWaste(base, clock.local.date))
					}
				}
			} else if (routine.key === 'morning_brief') {
				if (clock.local.time >= ROUTINE_MORNING_FROM_TIME) {
					if (!(await runKeyExists(db, routine, clock.local.date))) {
						results.push(await runMorningBrief(base, clock.local.date, now))
					}
				}
			} else {
				for (const result of await runCutoffReminders(base, now)) {
					if (!(await runKeyExists(db, routine, result.runKey))) results.push(result)
				}
			}
			for (const result of results) {
				if (await insertRun(db, routine, result, now)) outcome.runs += 1
			}
		} catch (error) {
			outcome.errors += 1
			await insertRun(
				db,
				routine,
				{
					runKey: `failed:${now}`,
					status: 'failed',
					summary: { error: error instanceof Error ? error.name : 'unknown' },
					notify: null,
				},
				now,
			).catch(() => undefined)
		}
	}

	// The messages still waiting for the App.
	const pending = await db
		.select()
		.from(invRoutineRuns)
		.where(eq(invRoutineRuns.alertStatus, 'pending'))
		.orderBy(asc(invRoutineRuns.createdAt), asc(invRoutineRuns.id))
		.limit(ALERT_BATCH)
	for (const run of pending) {
		if (now - run.createdAt > ALERT_GIVE_UP_MS || run.alertAttempts >= ALERT_MAX_ATTEMPTS) {
			await db.update(invRoutineRuns).set({ alertStatus: 'sent' }).where(eq(invRoutineRuns.id, run.id))
			outcome.errors += 1
			continue
		}
		if (Date.now() >= deadline) {
			outcome.alertsDeferred += 1
			continue
		}
		const summary = run.summaryJson as SummaryOf
		const drafts = Array.isArray(summary.drafted) ? summary.drafted.length : 0
		const asDrafts = run.key === 'count_low_stock' && drafts > 0
		const event: InventoryNotifyEvent = asDrafts
			? {
					orgId,
					eventId: eventId(orgId, 'inventory_repeat_order_draft', run.locationId, run.id),
					kind: 'inventory_repeat_order_draft',
					locationId: run.locationId,
					count: drafts,
				}
			: {
					orgId,
					eventId: eventId(orgId, 'inventory_routine', run.locationId, run.id),
					kind: 'inventory_routine',
					locationId: run.locationId,
					count: 1,
					routine: { key: run.key, runId: run.id },
				}
		const result = await post(event)
		if (result.status === 'retry') {
			await db
				.update(invRoutineRuns)
				.set({ alertAttempts: run.alertAttempts + 1 })
				.where(eq(invRoutineRuns.id, run.id))
			outcome.alertsDeferred += 1
			continue
		}
		await db
			.update(invRoutineRuns)
			.set({ alertStatus: 'sent', alertAttempts: run.alertAttempts + 1 })
			.where(eq(invRoutineRuns.id, run.id))
		if (result.status === 'delivered') outcome.alertsSent += 1
		else outcome.errors += 1
	}
	return outcome
}
