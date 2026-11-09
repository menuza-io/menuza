import { DEFAULT_KDS_CONFIG, kdsConfigSchema } from '@repo/common/kds'
import {
	type DoneTask,
	isRamadan,
	PREP_DAYS_AHEAD,
	PREP_DAYS_BEHIND,
	PREP_HISTORY_DAYS,
	type PrepLevels,
	type PrepPlan,
	type PrepTask,
	type PutPrepLevels as PutPrepLevelsInput,
	suggestPrepAmount,
	weekdayDemand,
	type DailyUnits,
} from '@repo/inventory'
import { addDays, dayOfWeek } from '@repo/reservations'
import {
	getTenantDb,
	invAuditLog,
	invItems,
	invPrepItems,
	invPrepLevels,
	invPrepTasks,
	kdsLocationSettings,
} from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	hashInventoryRequest,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordBatch } from './inventory-batch-service.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	defaultCountUnit,
	locationBusinessDate,
	newId,
	notFound,
	wireUnit,
} from './inventory-common.ts'
import {
	loadLocationStock,
	toItemUnit,
	type InventoryCaller,
	type StockRow,
} from './inventory-items-service.ts'
import { loadVersionsAt } from './inventory-recipe-store.ts'
import { getInventorySettings } from './inventory-settings-service.ts'
import { committedFromLocation } from './inventory-transfers-service.ts'
import { readItemSales } from './item-sales.ts'

/**
 * Prep (phase 4): the day's list of made-in-house items to make, and the three
 * things a cook does with a task (start, done, skip). The plan is worked out by
 * `suggestPrepAmount` from the weekday's "fill up to", what is on hand and how
 * busy the weekday is (`weekdayDemand`, Ramadan aware). Done records a batch
 * in the same transaction, so a task is never done without its stock moving.
 *
 * Quantities are base thousandths; no money anywhere.
 */

/** Tasks of a day are listed in this order of status, then by name. */
const STATUS_ORDER = { in_progress: 0, todo: 1, done: 2, skipped: 3 } as const

async function kitchenStations(
	db: InventoryReader,
	locationId: string,
): Promise<{ id: string; name: string }[]> {
	const row = await db
		.select({ config: kdsLocationSettings.config })
		.from(kdsLocationSettings)
		.where(eq(kdsLocationSettings.locationId, locationId))
		.get()
	const parsed = kdsConfigSchema.safeParse(row?.config)
	const config = parsed.success ? parsed.data : DEFAULT_KDS_CONFIG
	return config.stations.map((station) => ({
		id: station.id,
		name: station.name,
	}))
}

function assertDateInRange(date: string, today: string): void {
	if (
		date < addDays(today, -PREP_DAYS_BEHIND) ||
		date > addDays(today, PREP_DAYS_AHEAD)
	) {
		throw badRequest('date')
	}
}

/** Dishes sold per day over the history window, for the weekday factor. */
async function dailyUnits(
	db: InventoryReader,
	input: { locationId: string; date: string },
): Promise<DailyUnits[]> {
	const sales = await readItemSales(db, {
		locationId: input.locationId,
		fromDate: addDays(input.date, -PREP_HISTORY_DAYS),
		toDate: addDays(input.date, -1),
	})
	const byDate = new Map<string, number>()
	for (const row of sales.items) {
		byDate.set(
			row.businessDate,
			(byDate.get(row.businessDate) ?? 0) + row.quantity,
		)
	}
	return [...byDate.entries()].map(([date, units]) => ({ date, units }))
}

type MadeStock = StockRow & { item: StockRow['item'] & { kind: 'made' } }

async function madeItems(
	db: InventoryReader,
	locationId: string,
): Promise<MadeStock[]> {
	const stock = await loadLocationStock(db, locationId)
	return stock.filter((row) => row.item.kind === 'made') as MadeStock[]
}

async function countUnitOf(
	row: StockRow,
	system: 'metric' | 'us',
): Promise<ReturnType<typeof wireUnit>> {
	return row.place?.countUnit
		? wireUnit(row.place.countUnit)
		: wireUnit(defaultCountUnit(row.item.baseUnit, system))
}

type TaskRow = typeof invPrepTasks.$inferSelect

async function toPlan(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		date: string
		stationId?: string
		now: number
	},
): Promise<PrepPlan> {
	const [stations, rows, settings, made] = await Promise.all([
		kitchenStations(db, input.locationId),
		db
			.select()
			.from(invPrepTasks)
			.where(
				and(
					eq(invPrepTasks.locationId, input.locationId),
					eq(invPrepTasks.businessDate, input.date),
				),
			)
			.orderBy(asc(invPrepTasks.createdAt), asc(invPrepTasks.id)),
		getInventorySettings(db, input.caller.region),
		madeItems(db, input.locationId),
	])
	const levelRows = await db
		.select({ itemId: invPrepLevels.itemId })
		.from(invPrepLevels)
		.where(eq(invPrepLevels.locationId, input.locationId))
	// A day with nothing to make is still planned: generating records it.
	const planned = await db
		.select({ id: invAuditLog.id })
		.from(invAuditLog)
		.where(
			and(
				eq(invAuditLog.action, 'prep.generate'),
				eq(invAuditLog.resourceId, input.date),
				eq(invAuditLog.locationId, input.locationId),
			),
		)
		.limit(1)
		.get()
	const withLevels = new Set(levelRows.map((row) => row.itemId))
	const canGenerate = made.some(
		(row) =>
			row.item.archivedAt === null &&
			(withLevels.has(row.item.id) ||
				(row.place?.fillUpToQuantity ?? null) !== null),
	)
	const byItem = new Map(made.map((row) => [row.item.id, row]))
	const versions = await loadVersionsAt(
		db,
		'made_item',
		[...new Set(rows.map((row) => row.itemId))],
		input.now,
	)
	const batchByItem = new Map(
		versions.map((version) => [version.ownerId, version.makesQuantity]),
	)
	const committed = await committedFromLocation(db, input.locationId)
	const tasks: PrepTask[] = []
	for (const row of rows as TaskRow[]) {
		const stock = byItem.get(row.itemId)
		if (!stock) continue
		if (
			input.stationId &&
			row.stationId !== null &&
			row.stationId !== input.stationId
		) {
			continue
		}
		const batchSize = batchByItem.get(row.itemId) ?? null
		tasks.push({
			id: row.id,
			itemId: row.itemId,
			itemName: stock.item.name,
			baseUnit: stock.item.baseUnit,
			countUnit: await countUnitOf(stock, settings.unitSystem),
			units: stock.units.map(toItemUnit),
			stationId: row.stationId,
			businessDate: row.businessDate,
			plannedQuantity: row.plannedQuantity,
			batchSize,
			batches:
				batchSize && batchSize > 0
					? Math.round(row.plannedQuantity / batchSize)
					: null,
			explain: {
				fillUpTo: Math.round(
					(Math.max(
						0,
						row.fillUpToQuantity - (committed.get(row.itemId) ?? 0),
					) *
						10_000) /
						Math.max(1, row.demandBp),
				),
				target: row.fillUpToQuantity,
				onHand: row.onHandQuantity,
				demandBp: row.demandBp,
				...((committed.get(row.itemId) ?? 0) > 0
					? { committed: committed.get(row.itemId)! }
					: {}),
			},
			status: row.status,
			startedAt: row.startedAt,
			doneAt: row.doneAt,
			madeQuantity: row.madeQuantity,
			version: row.version,
		})
	}
	tasks.sort(
		(a, b) =>
			STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
			a.itemName.toLowerCase().localeCompare(b.itemName.toLowerCase()) ||
			(a.id < b.id ? -1 : 1),
	)
	const demandBp = tasks[0]?.explain.demandBp ?? 10_000
	return {
		locationId: input.locationId,
		date: input.date,
		stations,
		demand: {
			bp: demandBp,
			known: demandBp !== 10_000,
			ramadan: isRamadan(input.date),
			samples: 0,
		},
		generated: rows.length > 0 || planned !== undefined,
		canGenerate,
		tasks,
	}
}

export async function getPrepPlan(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		date?: string
		stationId?: string
		now: number
	},
): Promise<PrepPlan> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const today = await locationBusinessDate(db, input.locationId, input.now)
	const date = input.date ?? today
	assertDateInRange(date, today)
	return toPlan(db, { ...input, date })
}

/**
 * Makes the day's plan, or refreshes the tasks that have not been started
 * (their numbers follow stock and the day's pattern); started, done and
 * skipped tasks are never touched. A made item that no longer needs making has
 * its untouched task removed. Idempotent.
 */
export async function generatePrep(
	caller: InventoryCaller,
	input: { locationId: string; date?: string },
): Promise<PrepPlan> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	const { locationId } = input
	// Reading a month of sales is the slow part: done before the write lock.
	const startedAt = Date.now()
	const read = await getTenantDb(caller.orgId)
	const today = await locationBusinessDate(read, locationId, startedAt)
	const date = input.date ?? today
	assertDateInRange(date, today)
	const history = await dailyUnits(read, { locationId, date })
	const demand = weekdayDemand({ date, history })

	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const weekday = dayOfWeek(date)
		const [made, levelRows, stationRows, existing] = await Promise.all([
			madeItems(tx, locationId),
			tx
				.select()
				.from(invPrepLevels)
				.where(
					and(
						eq(invPrepLevels.locationId, locationId),
						eq(invPrepLevels.weekday, weekday),
					),
				),
			tx
				.select()
				.from(invPrepItems)
				.where(eq(invPrepItems.locationId, locationId)),
			tx
				.select()
				.from(invPrepTasks)
				.where(
					and(
						eq(invPrepTasks.locationId, locationId),
						eq(invPrepTasks.businessDate, date),
					),
				),
		])
		const levelOf = new Map(
			levelRows.map((row) => [row.itemId, row.fillUpToQuantity]),
		)
		const stationOf = new Map(
			stationRows.map((row) => [row.itemId, row.stationId]),
		)
		const taskOf = new Map(existing.map((row) => [row.itemId, row]))
		const active = made.filter((row) => row.item.archivedAt === null)
		const versions = await loadVersionsAt(
			tx,
			'made_item',
			active.map((row) => row.item.id),
			ctx.now,
		)
		const batchOf = new Map(
			versions.map((version) => [version.ownerId, version.makesQuantity]),
		)
		// A central kitchen also makes what its branches have asked for.
		const committed = await committedFromLocation(tx, locationId)

		let changed = 0
		for (const row of active) {
			const fillUp =
				levelOf.get(row.item.id) ?? row.place?.fillUpToQuantity ?? null
			const task = taskOf.get(row.item.id)
			// A made item that is not counted in batches is never made ahead:
			// its sales use its ingredients directly, so a batch would take the
			// ingredients out twice (an untouched task from before the switch
			// went off goes too).
			if (!row.item.batchCounted) {
				if (task && task.status === 'todo') {
					await tx.delete(invPrepTasks).where(eq(invPrepTasks.id, task.id))
					changed += 1
				}
				continue
			}
			if (fillUp === null) {
				// A level taken away: an untouched task goes with it.
				if (task && task.status === 'todo') {
					await tx.delete(invPrepTasks).where(eq(invPrepTasks.id, task.id))
					changed += 1
				}
				continue
			}
			const suggestion = suggestPrepAmount({
				fillUpTo: fillUp,
				onHand: row.onHand,
				demandBp: demand.bp,
				batchSize: batchOf.get(row.item.id) ?? null,
				committed: committed.get(row.item.id) ?? 0,
			})
			if (task && task.status !== 'todo') continue
			if (suggestion.amount <= 0) {
				if (task) {
					await tx.delete(invPrepTasks).where(eq(invPrepTasks.id, task.id))
					changed += 1
				}
				continue
			}
			const values = {
				stationId: stationOf.get(row.item.id) ?? null,
				plannedQuantity: suggestion.amount,
				fillUpToQuantity: suggestion.target,
				onHandQuantity: row.onHand,
				demandBp: demand.bp,
			}
			if (task) {
				const same =
					task.plannedQuantity === values.plannedQuantity &&
					task.fillUpToQuantity === values.fillUpToQuantity &&
					task.onHandQuantity === values.onHandQuantity &&
					task.demandBp === values.demandBp &&
					task.stationId === values.stationId
				if (same) continue
				await tx
					.update(invPrepTasks)
					.set({ ...values, version: task.version + 1, updatedAt: ctx.now })
					.where(eq(invPrepTasks.id, task.id))
			} else {
				await tx.insert(invPrepTasks).values({
					id: newId(),
					locationId,
					businessDate: date,
					itemId: row.item.id,
					...values,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
			}
			changed += 1
		}
		const planned = await tx
			.select({ id: invAuditLog.id })
			.from(invAuditLog)
			.where(
				and(
					eq(invAuditLog.action, 'prep.generate'),
					eq(invAuditLog.resourceId, date),
					eq(invAuditLog.locationId, locationId),
				),
			)
			.limit(1)
			.get()
		if (changed > 0 || !planned) {
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'prep.generate',
				resourceType: 'prep',
				resourceId: date,
				locationId,
				detail: { tasks: changed },
				at: ctx.now,
			})
		}
		return toPlan(tx, {
			caller,
			locationId,
			date,
			now: ctx.now,
		})
	})
}

// ── Levels ──────────────────────────────────────────────────────────────────

export async function getPrepLevels(
	db: InventoryReader,
	input: { caller: InventoryCaller; locationId: string; now: number },
): Promise<PrepLevels> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const [stations, made, levelRows, itemRows, settings] = await Promise.all([
		kitchenStations(db, input.locationId),
		madeItems(db, input.locationId),
		db
			.select()
			.from(invPrepLevels)
			.where(eq(invPrepLevels.locationId, input.locationId)),
		db
			.select()
			.from(invPrepItems)
			.where(eq(invPrepItems.locationId, input.locationId)),
		getInventorySettings(db, input.caller.region),
	])
	const active = made.filter((row) => row.item.archivedAt === null)
	const versions = await loadVersionsAt(
		db,
		'made_item',
		active.map((row) => row.item.id),
		input.now,
	)
	const batchOf = new Map(
		versions.map((version) => [version.ownerId, version.makesQuantity]),
	)
	const prepOf = new Map(itemRows.map((row) => [row.itemId, row]))
	const weekdaysOf = new Map<string, (number | null)[]>()
	for (const row of levelRows) {
		const list =
			weekdaysOf.get(row.itemId) ??
			(Array.from({ length: 7 }, () => null) as (number | null)[])
		list[row.weekday] = row.fillUpToQuantity
		weekdaysOf.set(row.itemId, list)
	}
	const items = await Promise.all(
		active.map(async (row) => ({
			itemId: row.item.id,
			name: row.item.name,
			baseUnit: row.item.baseUnit,
			countUnit: await countUnitOf(row, settings.unitSystem),
			units: row.units.map(toItemUnit),
			stationId: prepOf.get(row.item.id)?.stationId ?? null,
			weekdays:
				weekdaysOf.get(row.item.id) ??
				(Array.from({ length: 7 }, () => null) as (number | null)[]),
			usual: row.place?.fillUpToQuantity ?? null,
			batchSize: batchOf.get(row.item.id) ?? null,
			version: prepOf.get(row.item.id)?.version ?? 0,
		})),
	)
	items.sort(
		(a, b) =>
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
			(a.itemId < b.itemId ? -1 : 1),
	)
	return { locationId: input.locationId, stations, items }
}

export async function putPrepLevels(
	caller: InventoryCaller,
	input: PutPrepLevelsInput,
): Promise<PrepLevels['items'][number]> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await tx
			.select()
			.from(invItems)
			.where(eq(invItems.id, input.itemId))
			.get()
		if (!item || item.archivedAt !== null) throw notFound()
		if (item.kind !== 'made') throw new InventoryError('not_a_made_item', 400)
		if (input.stationId !== null) {
			const stations = await kitchenStations(tx, input.locationId)
			if (!stations.some((station) => station.id === input.stationId)) {
				throw badRequest('station')
			}
		}
		const current = await tx
			.select()
			.from(invPrepItems)
			.where(
				and(
					eq(invPrepItems.itemId, input.itemId),
					eq(invPrepItems.locationId, input.locationId),
				),
			)
			.get()
		assertVersion(current?.version ?? 0, input.expectedVersion)
		if (current) {
			await tx
				.update(invPrepItems)
				.set({
					stationId: input.stationId,
					version: current.version + 1,
					updatedAt: ctx.now,
				})
				.where(
					and(
						eq(invPrepItems.itemId, input.itemId),
						eq(invPrepItems.locationId, input.locationId),
					),
				)
		} else {
			await tx.insert(invPrepItems).values({
				itemId: input.itemId,
				locationId: input.locationId,
				stationId: input.stationId,
				updatedAt: ctx.now,
			})
		}
		await tx
			.delete(invPrepLevels)
			.where(
				and(
					eq(invPrepLevels.itemId, input.itemId),
					eq(invPrepLevels.locationId, input.locationId),
				),
			)
		for (const [weekday, quantity] of input.weekdays.entries()) {
			if (quantity === null) continue
			await tx.insert(invPrepLevels).values({
				itemId: input.itemId,
				locationId: input.locationId,
				weekday,
				fillUpToQuantity: quantity,
				updatedAt: ctx.now,
			})
		}
		if (!item.batchCounted && input.weekdays.some((q) => q !== null)) {
			await tx
				.update(invItems)
				.set({
					batchCounted: true,
					version: item.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invItems.id, item.id))
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'prep.levels',
			resourceType: 'item',
			resourceId: input.itemId,
			locationId: input.locationId,
			detail: { weekdays: input.weekdays.filter((q) => q !== null).length },
			at: ctx.now,
		})
	})
	const db = await getTenantDb(caller.orgId)
	const levels = await getPrepLevels(db, {
		caller,
		locationId: input.locationId,
		now: Date.now(),
	})
	const found = levels.items.find((entry) => entry.itemId === input.itemId)
	if (!found) throw notFound()
	return found
}

// ── Tasks ───────────────────────────────────────────────────────────────────

async function loadTask(
	tx: InventoryReader,
	id: string,
	caller: InventoryCaller,
): Promise<TaskRow> {
	const row = await tx
		.select()
		.from(invPrepTasks)
		.where(eq(invPrepTasks.id, id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
}

async function taskView(
	caller: InventoryCaller,
	id: string,
	now: number,
	db: InventoryReader,
): Promise<PrepTask> {
	const row = await db
		.select()
		.from(invPrepTasks)
		.where(eq(invPrepTasks.id, id))
		.get()
	if (!row) throw notFound()
	const plan = await toPlan(db, {
		caller,
		locationId: row.locationId,
		date: row.businessDate,
		now,
	})
	const task = plan.tasks.find((entry) => entry.id === id)
	if (!task) throw notFound()
	return task
}

/** Starts a task (a second start by someone else is a stale version). */
export async function startPrepTask(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<PrepTask> {
	const now = await withInventoryWrite(
		{ orgId: caller.orgId },
		async (tx, ctx) => {
			const row = await loadTask(tx, input.id, caller)
			// A second tap (or a retry after a lost answer) finds it started.
			if (row.status === 'in_progress') return ctx.now
			assertVersion(row.version, input.expectedVersion)
			if (row.status !== 'todo') throw new InventoryError('task_closed', 409)
			await tx
				.update(invPrepTasks)
				.set({
					status: 'in_progress',
					startedAt: ctx.now,
					startedByKind: caller.actor.kind,
					startedById: caller.actor.id,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invPrepTasks.id, row.id))
			return ctx.now
		},
	)
	return taskView(caller, input.id, now, await readDb(caller))
}

/** Skips a task: nothing made, nothing recorded (the cook decided against it). */
export async function skipPrepTask(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<PrepTask> {
	const now = await withInventoryWrite(
		{ orgId: caller.orgId },
		async (tx, ctx) => {
			const row = await loadTask(tx, input.id, caller)
			assertVersion(row.version, input.expectedVersion)
			if (row.status === 'done' || row.status === 'skipped') {
				throw new InventoryError('task_closed', 409)
			}
			await tx
				.update(invPrepTasks)
				.set({
					status: 'skipped',
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invPrepTasks.id, row.id))
			return ctx.now
		},
	)
	return taskView(caller, input.id, now, await readDb(caller))
}

/**
 * Done: records a batch of the made item (it goes into stock, its ingredients
 * come out) and closes the task in the same transaction. The same `clientId`
 * answers the first result, so a repeated tap or a retry after a lost answer
 * never records the food twice.
 */
export async function donePrepTask(
	caller: InventoryCaller,
	input: { id: string; body: DoneTask },
): Promise<PrepTask> {
	const { body } = input
	const now = await withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: {
				scope: `prep_done:${caller.actor.id ?? caller.actor.kind}:${input.id}`,
				key: body.clientId,
				requestHash: hashInventoryRequest(body),
			},
		},
		async (tx, ctx) => {
			const row = await loadTask(tx, input.id, caller)
			assertVersion(row.version, body.expectedVersion)
			if (row.status === 'done' || row.status === 'skipped') {
				throw new InventoryError('task_closed', 409)
			}
			const batch = await recordBatch(caller, {
				itemId: row.itemId,
				body: {
					clientId: body.clientId,
					locationId: row.locationId,
					made: body.made,
					...(body.note ? { note: body.note } : {}),
				},
				idempotency: null,
			})
			await tx
				.update(invPrepTasks)
				.set({
					status: 'done',
					startedAt: row.startedAt ?? ctx.now,
					startedByKind: row.startedByKind ?? caller.actor.kind,
					startedById: row.startedById ?? caller.actor.id,
					doneAt: ctx.now,
					doneByKind: caller.actor.kind,
					doneById: caller.actor.id,
					madeQuantity: batch.madeQuantity,
					batchSourceId: batch.id,
					version: row.version + 1,
					updatedAt: ctx.now,
				})
				.where(eq(invPrepTasks.id, row.id))
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'prep.done',
				resourceType: 'item',
				resourceId: row.itemId,
				locationId: row.locationId,
				detail: { made: batch.madeQuantity, planned: row.plannedQuantity },
				at: ctx.now,
			})
			return ctx.now
		},
	)
	return taskView(caller, input.id, now, await readDb(caller))
}

function readDb(caller: InventoryCaller) {
	return getTenantDb(caller.orgId)
}
