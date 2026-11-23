import {
	type CountEntryRefusalCode,
	type CountKind,
	type CountReview,
	type CountSecondCheck,
	type CountSheet,
	type CountSummary,
	inventoryValueMinor,
	needsReview,
	type UnitRef,
} from '@repo/inventory'
import {
	invCountEntries,
	invCountLists,
	invCountSecondChecks,
	invCounts,
	invItems,
	invMovements,
	invStorageAreas,
} from '@repo/tenant-db'
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { insertRowsInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	type InventoryWriteContext,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	decodeCursor,
	defaultCountUnit,
	encodeCursor,
	type InventoryActor,
	loadItemUnits,
	locationBusinessDate,
	markUnitsUsed,
	newId,
	notFound,
	stateConflict,
	storedUnit,
	typedToBase,
	wireUnit,
} from './inventory-common.ts'
import {
	type ApproveCountInput,
	type CountEntriesInput,
	type ListCountsQuery,
} from './inventory-contract-types.ts'
import { computeFoodCost, countInstants } from './inventory-food-cost.ts'
import {
	type InventoryCaller,
	itemBottleOf,
	loadLocationStock,
	type StockRow,
	toItemUnit,
} from './inventory-items-service.ts'
import {
	type AsOf,
	type CountRow,
	COUNTING,
	countScope,
	countedAtByItem,
	countedTotals,
	type EntryRow,
	expectedAsOf,
	firstPass,
	liveEntries,
	loadAllowedCount,
	loadCount,
	loadEntries,
	OPEN_STATUSES,
	CLEARED,
	secondPass,
} from './inventory-count-core.ts'
import {
	actorKey,
	countDevicesStillCounting,
	type DeviceReport,
	listCountDevices,
	personKeys,
	recordCountDevice,
} from './inventory-count-devices.ts'
import {
	countOpenLateEntries,
	lateClientIds,
	type LateEntryInput,
	storeLateEntries,
} from './inventory-count-late.ts'
import { claimRunForCount } from './inventory-count-schedules-service.ts'
import { getLocationCountControls } from './inventory-location-settings.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

export { liveEntries }

type ReviewLineData = {
	row: StockRow
	counted: number | null
	expected: number
	difference: number | null
	valueMinor: number | null
	flag: 'not_counted' | 'big_difference' | null
	/** When the item was counted (its latest live entry), null when nobody did. */
	countedAt: number | null
	superseded: boolean
}

function reviewData(
	scope: readonly StockRow[],
	totals: ReadonlyMap<string, number>,
	countedAt: ReadonlyMap<string, number>,
	asOf: ReadonlyMap<string, AsOf>,
): ReviewLineData[] {
	return scope.map((row) => {
		const counted = totals.get(row.item.id) ?? null
		if (counted === null) {
			return {
				row,
				counted,
				expected: row.onHand,
				difference: null,
				valueMinor: null,
				flag: 'not_counted' as const,
				countedAt: null,
				superseded: false,
			}
		}
		const found = asOf.get(row.item.id)
		const superseded = found?.superseded === true
		// A later approved count measured this item after this one did: nothing
		// is left to adjust (approval skips it), so it reads as matching.
		const expected = superseded ? counted : (found?.expected ?? row.onHand)
		const difference = counted - expected
		const avg = row.cost?.avgCostMicro ?? null
		const valueMinor =
			avg === null ? null : inventoryValueMinor(difference, avg)
		const flag = needsReview({
			expected,
			counted,
			differenceValueMinor: valueMinor,
		})
			? ('big_difference' as const)
			: null
		return {
			row,
			counted,
			expected,
			difference,
			valueMinor,
			flag,
			countedAt: countedAt.get(row.item.id) ?? null,
			superseded,
		}
	})
}

/**
 * The count's own figures: the first pass's live entries, summed per item, with
 * the second person's figure standing where a manager settled a key item that
 * way (#525). The second person's blind entries are never added in.
 */
async function countFigures(
	db: InventoryReader,
	row: CountRow,
	entries: readonly EntryRow[],
): Promise<{
	live: EntryRow[]
	totals: Map<string, number>
	countedAt: Map<string, number>
}> {
	const live = liveEntries(firstPass(entries))
	const totals = countedTotals(live)
	const countedAt = countedAtByItem(live)
	if (row.secondState !== null) {
		const settled = await db
			.select()
			.from(invCountSecondChecks)
			.where(
				and(
					eq(invCountSecondChecks.countId, row.id),
					eq(invCountSecondChecks.resolution, 'second'),
				),
			)
		for (const check of settled) {
			if (check.secondQuantity === null) continue
			totals.set(check.itemId, check.secondQuantity)
			countedAt.set(
				check.itemId,
				Math.max(check.secondCountedAt ?? 0, countedAt.get(check.itemId) ?? 0),
			)
		}
	}
	return { live, totals, countedAt }
}

/** Everything a review or an approval needs from one count's entries and the ledger. */
async function reviewInputs(
	db: InventoryReader,
	row: CountRow,
	entries: readonly EntryRow[],
	stock: StockRow[],
) {
	const { totals, countedAt } = await countFigures(db, row, entries)
	const scope = await countScope(db, row, stock)
	const asOf = await expectedAsOf(db, row.locationId, scope, countedAt)
	return {
		scope,
		totals,
		countedAt,
		data: reviewData(scope, totals, countedAt, asOf),
	}
}

function netDifference(lines: readonly ReviewLineData[]): number {
	return lines.reduce((sum, line) => sum + (line.valueMinor ?? 0), 0)
}

function stockCurrency(scope: readonly StockRow[]): string | undefined {
	return scope.find((row) => row.cost)?.cost?.currency
}

// ── Summaries ───────────────────────────────────────────────────────────────

/** Summaries of counts, with the money of approved and pending differences. */
async function summarize(
	db: InventoryReader,
	rows: readonly CountRow[],
	caller: Pick<InventoryCaller, 'cost' | 'locationIds'>,
): Promise<CountSummary[]> {
	if (rows.length === 0) return []
	const ids = rows.map((row) => row.id)
	const listIds = [...new Set(rows.map((row) => row.listId).filter((id) => id))]
	const [entries, lists, posted, stillCounting, lateOpen] = await Promise.all([
		loadEntries(db, ids),
		queryInChunks(listIds as string[], (chunk) =>
			db
				.select({ id: invCountLists.id, name: invCountLists.name })
				.from(invCountLists)
				.where(inArray(invCountLists.id, chunk)),
		),
		caller.cost
			? queryInChunks(
					rows.filter((row) => row.status === 'approved').map((row) => row.id),
					(countChunk) =>
						db
							.select({
								countId: invMovements.sourceId,
								total: sql<number>`coalesce(sum(${invMovements.valueMinor}), 0)`,
								currency: sql<string | null>`max(${invMovements.currency})`,
							})
							.from(invMovements)
							.where(
								and(
									eq(invMovements.sourceType, 'count'),
									inArray(invMovements.sourceId, countChunk),
								),
							)
							.groupBy(invMovements.sourceId),
				)
			: Promise.resolve([]),
		countDevicesStillCounting(
			db,
			rows
				.filter((row) =>
					(OPEN_STATUSES as readonly string[]).includes(row.status),
				)
				.map((row) => row.id),
		),
		countOpenLateEntries(
			db,
			rows.filter((row) => row.status === 'approved').map((row) => row.id),
		),
	])
	const listName = new Map(lists.map((row) => [row.id, row.name]))
	const postedByCount = new Map(posted.map((row) => [row.countId, row]))
	const stockByLocation = new Map<string, StockRow[]>()
	const result: CountSummary[] = []
	for (const row of rows) {
		const figures = await countFigures(db, row, entries.get(row.id) ?? [])
		const totals = figures.totals
		const counters: CountSummary['counters'] = []
		const seen = new Set<string>()
		for (const entry of firstPass(entries.get(row.id) ?? [])) {
			const key = `${entry.counterKind}|${entry.counterId ?? ''}`
			if (seen.has(key)) continue
			seen.add(key)
			counters.push({ kind: entry.counterKind, id: entry.counterId })
		}
		let itemTotal = totals.size
		let difference: { valueMinor: number; currency?: string } | null = null
		if ((OPEN_STATUSES as readonly string[]).includes(row.status)) {
			let stock = stockByLocation.get(row.locationId)
			if (!stock) {
				stock = await loadLocationStock(db, row.locationId)
				stockByLocation.set(row.locationId, stock)
			}
			const scope = await countScope(db, row, stock)
			itemTotal = scope.length
			if (row.status === 'in_review' && caller.cost) {
				const countedAt = figures.countedAt
				const asOf = await expectedAsOf(db, row.locationId, scope, countedAt)
				difference = {
					valueMinor: netDifference(reviewData(scope, totals, countedAt, asOf)),
					currency: stockCurrency(scope),
				}
			}
		} else if (row.status === 'approved' && caller.cost) {
			const found = postedByCount.get(row.id)
			difference = {
				valueMinor: Number(found?.total ?? 0),
				currency: found?.currency ?? undefined,
			}
		}
		const summary: CountSummary = {
			id: row.id,
			locationId: row.locationId,
			listId: row.listId,
			listName: row.listId ? (listName.get(row.listId) ?? null) : null,
			status: row.status,
			businessDate: row.businessDate,
			startedBy: { kind: row.startedByKind, id: row.startedById },
			itemTotal,
			itemsCounted: totals.size,
			counters,
			sentForReviewAt: row.sentForReviewAt,
			approvedAt: row.approvedAt,
			approvedBy: row.approvedById
				? { kind: 'operator', id: row.approvedById }
				: null,
			cancelledAt: row.cancelledAt,
			createdAt: row.createdAt,
			version: row.version,
			kind: row.kind,
			scheduleRunId: row.scheduleRunId,
			secondState: row.secondState,
			devicesCounting: stillCounting.get(row.id) ?? 0,
			lateEntries: lateOpen.get(row.id) ?? 0,
		}
		if (difference) {
			summary.differenceValueMinor = difference.valueMinor
			if (difference.currency) summary.currency = difference.currency
		}
		result.push(summary)
	}
	return result
}

export async function getCountSummary(
	db: InventoryReader,
	id: string,
	caller: Pick<InventoryCaller, 'cost' | 'locationIds'>,
): Promise<CountSummary> {
	const row = await loadAllowedCount(db, id, caller)
	return (await summarize(db, [row], caller))[0]!
}

export async function listCounts(
	db: InventoryReader,
	input: {
		query: ListCountsQuery
		caller: Pick<InventoryCaller, 'cost' | 'locationIds'>
	},
) {
	const { query } = input
	const cursor = decodeCursor(query.cursor)
	const rows = await db
		.select()
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, query.locationId),
				query.status === 'open'
					? inArray(invCounts.status, [...OPEN_STATUSES])
					: query.status === 'closed'
						? inArray(invCounts.status, ['approved', 'cancelled'])
						: undefined,
				cursor
					? or(
							sql`${invCounts.createdAt} < ${cursor.sort}`,
							and(
								eq(invCounts.createdAt, cursor.sort),
								sql`${invCounts.id} < ${cursor.id}`,
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(invCounts.createdAt), desc(invCounts.id))
		.limit(query.limit + 1)
	const page = rows.slice(0, query.limit)
	const last = page.at(-1)
	return {
		counts: await summarize(db, page, input.caller),
		nextCursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	}
}

// ── Start, send, reopen, cancel ─────────────────────────────────────────────

type StartCountInput = {
	clientId: string
	locationId: string
	listId: string | null
	/** `quick` counts the key items (or the list); absent: a full count (#490). */
	kind?: CountKind
	idempotency: InventoryIdempotency
	/** Station: the session's person, named in the audit trail when someone else is the actor. */
	syncedBy?: string
}

/**
 * Opens a count, or (`join`, Station) answers the one being counted for the
 * location and list instead of refusing with `count_in_progress`. Only a count
 * in `counting` is joined or blocks a start: one `in_review` is left alone and
 * a new count is created beside it.
 */
async function openCount(
	tx: InventoryTx,
	ctx: InventoryWriteContext,
	caller: InventoryCaller,
	input: StartCountInput,
	join: boolean,
): Promise<{ count: CountSummary; joined: boolean }> {
	if (input.listId) {
		const list = await tx
			.select()
			.from(invCountLists)
			.where(eq(invCountLists.id, input.listId))
			.get()
		if (
			!list ||
			list.archivedAt !== null ||
			list.locationId !== input.locationId
		) {
			throw notFound()
		}
	}
	const kind: CountKind = input.kind ?? 'full'
	const open = await tx
		.select({ id: invCounts.id })
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, input.locationId),
				eq(invCounts.status, COUNTING),
				eq(invCounts.kind, kind),
				input.listId
					? eq(invCounts.listId, input.listId)
					: isNull(invCounts.listId),
			),
		)
		.orderBy(invCounts.createdAt, invCounts.id)
		.limit(1)
		.get()
	if (open) {
		if (!join) {
			throw new InventoryError('count_in_progress', 409, { countId: open.id })
		}
		return {
			count: (await summarize(tx, [await loadCount(tx, open.id)], caller))[0]!,
			joined: true,
		}
	}
	const id = newId()
	await tx.insert(invCounts).values({
		id,
		locationId: input.locationId,
		listId: input.listId,
		kind,
		status: 'counting',
		businessDate: await locationBusinessDate(tx, input.locationId, ctx.now),
		startedByKind: caller.actor.kind,
		startedById: caller.actor.id,
		createdAt: ctx.now,
		updatedAt: ctx.now,
	})
	// A scheduled count (a close quick count, a weekly plan entry) is answered
	// by the first count of the same kind and list started that day (#490, #491).
	const runId = await claimRunForCount(tx, {
		locationId: input.locationId,
		kind,
		listId: input.listId,
		countId: id,
		now: ctx.now,
	})
	if (runId) {
		await tx
			.update(invCounts)
			.set({ scheduleRunId: runId })
			.where(eq(invCounts.id, id))
	}
	await recordInventoryAudit(tx, {
		actorKind: caller.actor.kind,
		actorId: caller.actor.id,
		action: 'count.start',
		resourceType: 'count',
		resourceId: id,
		locationId: input.locationId,
		detail:
			input.syncedBy && caller.actor.id !== input.syncedBy
				? { syncedBy: input.syncedBy }
				: undefined,
		at: ctx.now,
	})
	return {
		count: (await summarize(tx, [await loadCount(tx, id)], caller))[0]!,
		joined: false,
	}
}

export async function startCount(
	caller: InventoryCaller,
	input: StartCountInput,
): Promise<CountSummary> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => (await openCount(tx, ctx, caller, input, false)).count,
	)
}

/**
 * Station: starts a count, or joins the one being counted for the same
 * location and list so two tablets share one count (a count in `in_review` is
 * not joined: a new count starts). Idempotent by `clientId` (a replay answers
 * the first result, whether it started or joined).
 */
export async function startOrJoinCount(
	caller: InventoryCaller,
	input: StartCountInput,
): Promise<{ count: CountSummary; joined: boolean }> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		(tx, ctx) => openCount(tx, ctx, caller, input, true),
	)
}

/**
 * Station: "Send" is this tablet's "I'm done counting", nothing more. It
 * records an audit row (`count.device_done`, the device id, who synced it when
 * that is not the actor) and answers the count's UNCHANGED summary: it never
 * moves the count to `in_review` (only the operator's `send` does, the App's
 * "Finish"), so one tablet cannot close the count for the others. An approved
 * or cancelled count answers its summary too and records nothing. Idempotent:
 * by `clientId` a replay answers the first result.
 */
export async function markCountDeviceDone(
	caller: InventoryCaller,
	input: {
		id: string
		deviceId: string
		deviceName?: string | null
		syncedBy?: string
		idempotency: InventoryIdempotency
	},
): Promise<CountSummary> {
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const row = await loadAllowedCount(tx, input.id, caller)
			if (row.status === 'counting' || row.status === 'in_review') {
				// This tablet is done: the review stops warning about it (#474).
				await recordCountDevice(tx, {
					countId: row.id,
					device: {
						id: input.deviceId,
						kind: 'station',
						name: input.deviceName,
						unsent: 0,
						done: true,
					},
					person: caller.actor,
					now: ctx.now,
				})
				await recordInventoryAudit(tx, {
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					action: 'count.device_done',
					resourceType: 'count',
					resourceId: row.id,
					locationId: row.locationId,
					detail:
						input.syncedBy && caller.actor.id !== input.syncedBy
							? { deviceId: input.deviceId, syncedBy: input.syncedBy }
							: { deviceId: input.deviceId },
					at: ctx.now,
				})
			}
			return (await summarize(tx, [row], caller))[0]!
		},
	)
}

/**
 * A device reports itself without entries (an app that is idle, or about to go
 * offline with entries unsent). Records the sync and answers the count.
 */
export async function reportCountPresence(
	caller: InventoryCaller,
	input: { id: string; device: DeviceReport },
): Promise<CountSummary> {
	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const row = await loadAllowedCount(tx, input.id, caller)
			if (row.status === 'counting' || row.status === 'in_review') {
				await recordCountDevice(tx, {
					countId: row.id,
					device: input.device,
					person: caller.actor,
					now: ctx.now,
				})
			}
			return (await summarize(tx, [row], caller))[0]!
		},
	)
}

type Transition = 'send' | 'reopen' | 'cancel'

export async function transitionCount(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; action: Transition },
): Promise<CountSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedCount(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status === 'approved' || row.status === 'cancelled') {
			throw new InventoryError('count_closed', 409)
		}
		const set: Partial<typeof invCounts.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		let audit: string = `count.${input.action}`
		if (input.action === 'send') {
			if (row.status !== 'counting') throw stateConflict('not_counting')
			if (row.secondState === 'waiting' || row.secondState === 'settling') {
				throw new InventoryError('second_count_pending', 409, {
					state: row.secondState,
				})
			}
			if (row.secondState === null && (await needsSecondCheck(tx, row))) {
				// The count waits for a different person to count the key items
				// again; it reaches review only after that is settled (#525).
				set.secondState = 'waiting'
				set.secondStartedAt = ctx.now
				audit = 'count.second_wait'
			} else {
				set.status = 'in_review'
				set.sentForReviewAt = ctx.now
			}
		} else if (input.action === 'reopen') {
			const inSecond =
				row.status === 'counting' &&
				(row.secondState === 'waiting' || row.secondState === 'settling')
			if (row.status !== 'in_review' && !inSecond) {
				throw stateConflict('not_in_review')
			}
			if (!inSecond) {
				// Another count may have been started beside this one meanwhile: two
				// counts being counted for one list would split the tablets' entries.
				const beside = await tx
					.select({ id: invCounts.id })
					.from(invCounts)
					.where(
						and(
							eq(invCounts.locationId, row.locationId),
							eq(invCounts.status, COUNTING),
							eq(invCounts.kind, row.kind),
							row.listId
								? eq(invCounts.listId, row.listId)
								: isNull(invCounts.listId),
						),
					)
					.limit(1)
					.get()
				if (beside) {
					throw new InventoryError('count_in_progress', 409, {
						countId: beside.id,
					})
				}
			}
			set.status = 'counting'
			set.sentForReviewAt = null
			if (row.secondState !== null) {
				// Back to the first count: the second check starts over when it is sent again.
				set.secondState = null
				set.secondStartedAt = null
				await tx
					.delete(invCountSecondChecks)
					.where(eq(invCountSecondChecks.countId, row.id))
			}
		} else {
			set.status = 'cancelled'
			set.cancelledAt = ctx.now
		}
		await tx.update(invCounts).set(set).where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: audit,
			resourceType: 'count',
			resourceId: row.id,
			locationId: row.locationId,
			at: ctx.now,
		})
		return (await summarize(tx, [await loadCount(tx, row.id)], caller))[0]!
	})
}

// ── Sheet ───────────────────────────────────────────────────────────────────

export async function getCountSheet(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
): Promise<CountSheet> {
	const { caller } = input
	const row = await loadAllowedCount(db, input.id, caller)
	const [entries, stock, areas, settings] = await Promise.all([
		loadEntries(db, [row.id]),
		loadLocationStock(db, row.locationId),
		db
			.select()
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, row.locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
			.orderBy(invStorageAreas.sortOrder, invStorageAreas.id),
		getInventorySettings(db, caller.region),
	])
	const allEntries = entries.get(row.id) ?? []
	// While the count waits for its second person (#525), someone who did not
	// make the first count sees only the key items, blind: no figures at all.
	let pass: 1 | 2 = 1
	if (row.secondState === 'waiting' || row.secondState === 'settling') {
		const counters = firstCounters(allEntries)
		const keys = await personKeys(db, [caller.actor, ...counters])
		const me = keys.get(actorKey(caller.actor))
		const isFirst = counters.some((actor) => keys.get(actorKey(actor)) === me)
		if (!isFirst) pass = 2
	}
	const live = liveEntries(
		pass === 2 ? secondPass(allEntries) : firstPass(allEntries),
	)
	const fullScope = await countScope(db, row, stock)
	const scope =
		pass === 2 ? fullScope.filter((entry) => entry.item.isKey) : fullScope

	const quantity = new Map<string, number>()
	const mine = new Map<string, { amount: number; unit: UnitRef }>()
	for (const entry of live) {
		const key = `${entry.itemId}|${entry.areaId ?? ''}`
		if (pass === 1) {
			quantity.set(key, (quantity.get(key) ?? 0) + entry.quantity)
		}
		if (
			entry.counterKind === caller.actor.kind &&
			entry.counterId === caller.actor.id
		) {
			mine.set(key, {
				amount: Number(entry.enteredAmount),
				unit: wireUnit(entry.enteredUnit),
			})
		}
	}
	// The caller's latest entry wins when they typed in several units.
	const sheetItem = (stockRow: StockRow, areaId: string | null) => {
		const key = `${stockRow.item.id}|${areaId ?? ''}`
		const countUnit = stockRow.place?.countUnit
			? wireUnit(stockRow.place.countUnit)
			: defaultCountUnit(stockRow.item.baseUnit, settings.unitSystem)
		return {
			itemId: stockRow.item.id,
			name: stockRow.item.name,
			baseUnit: stockRow.item.baseUnit,
			countUnit,
			units: stockRow.units.map(toItemUnit),
			quantity: quantity.get(key) ?? null,
			mine: mine.get(key) ?? null,
			isKey: stockRow.item.isKey,
			bottle: itemBottleOf(stockRow.item),
		}
	}
	const byName = (a: StockRow, b: StockRow) =>
		a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase())
	const sheetAreas: CountSheet['areas'] = []
	for (const area of areas) {
		const items = scope
			.filter((entry) => entry.areaIds.includes(area.id))
			.sort(
				(a, b) =>
					(a.areaSort.get(area.id) ?? 0) - (b.areaSort.get(area.id) ?? 0) ||
					byName(a, b),
			)
		if (items.length === 0) continue
		sheetAreas.push({
			areaId: area.id,
			name: area.name,
			items: items.map((entry) => sheetItem(entry, area.id)),
		})
	}
	const unplaced = scope
		.filter((entry) => entry.areaIds.length === 0)
		.sort(byName)
	if (unplaced.length > 0) {
		sheetAreas.push({
			areaId: null,
			name: null,
			items: unplaced.map((entry) => sheetItem(entry, null)),
		})
	}
	return {
		count: (await summarize(db, [row], caller))[0]!,
		pass,
		areas: sheetAreas,
	}
}

// ── Entries ─────────────────────────────────────────────────────────────────

export type CountEntriesOptions = {
	/**
	 * Entries typed on a Station tablet: each entry is counted for the person
	 * who made it (`actorFor`, the session's person unless the tablet named
	 * another one on the roster), and the audit trail records who synced it
	 * (`syncedBy`) when that is someone else. Refusals are per entry for the
	 * App too (see `COUNT_ENTRY_REFUSAL_CODES`).
	 */
	station?: {
		actorFor: (clientId: string) => InventoryActor
		syncedBy: string
		/** Device clock when each entry was counted; bounded in the route. */
		madeAt?: (clientId: string) => number | undefined
	}
	/** The device sending these entries and how many it still holds (#474). */
	device?: DeviceReport
}

export async function addCountEntries(
	caller: InventoryCaller,
	input: { id: string; body: CountEntriesInput },
	options: CountEntriesOptions = {},
) {
	const { station } = options
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const count = await loadAllowedCount(tx, input.id, caller)
		const accepted: Array<{ clientId: string; quantity: number | null }> = []
		const duplicates: string[] = []
		const refused: Array<{ clientId: string; code: CountEntryRefusalCode }> = []
		const { entries } = input.body
		// `counting` and `in_review` take entries (the review reads them live). A
		// cancelled count refuses, per entry, after the replay check. An approved
		// count keeps what arrives late as late entries (#474): stored, listed for a
		// manager, never merged into the approved figures and never dropped.
		const cancelled = count.status === 'cancelled'
		const approved = count.status === 'approved'
		const clientIds = entries.map((entry) => entry.clientId)
		const [existing, existingLate] = await Promise.all([
			queryInChunks(clientIds, (chunk) =>
				tx
					.select({ clientId: invCountEntries.clientId })
					.from(invCountEntries)
					.where(inArray(invCountEntries.clientId, chunk)),
			),
			lateClientIds(tx, clientIds),
		])
		const taken = new Set([
			...existing.map((row) => row.clientId),
			...existingLate,
		])
		// The second-person check (#525): while the count waits for its second
		// person, entries are that person's blind count of key items.
		const inSecondPhase =
			count.status === 'counting' &&
			(count.secondState === 'waiting' || count.secondState === 'settling')
		let keyOf = new Map<string, string>()
		let firstKeys = new Set<string>()
		let keyItemIds = new Set<string>()
		if (inSecondPhase) {
			const priorEntries =
				(await loadEntries(tx, [count.id])).get(count.id) ?? []
			const first = firstCounters(priorEntries)
			const entryActors = entries.map((entry) =>
				station ? station.actorFor(entry.clientId) : caller.actor,
			)
			keyOf = await personKeys(tx, [...first, ...entryActors])
			firstKeys = new Set(first.map((actor) => keyOf.get(actorKey(actor))!))
			keyItemIds = await keyItemIdsOf(tx, count)
		}
		const lateRows: LateEntryInput[] = []
		const late: string[] = []
		const itemIds = [...new Set(entries.map((entry) => entry.itemId))]
		const itemRows = await queryInChunks(itemIds, (chunk) =>
			tx.select().from(invItems).where(inArray(invItems.id, chunk)),
		)
		const unitsByItem = await loadItemUnits(tx, itemIds)
		const byItem = new Map(
			itemRows.map((item) => [
				item.id,
				{ item, units: unitsByItem.get(item.id) ?? [] },
			]),
		)
		const areaRows = await tx
			.select({ id: invStorageAreas.id })
			.from(invStorageAreas)
			.where(
				and(
					eq(invStorageAreas.locationId, count.locationId),
					isNull(invStorageAreas.archivedAt),
				),
			)
		const areaIds = new Set(areaRows.map((row) => row.id))

		const rows: Array<typeof invCountEntries.$inferInsert> = []
		const usedUnits: string[] = []
		for (const entry of entries) {
			// A repeat keeps its first result, even when the count has closed since.
			if (taken.has(entry.clientId)) {
				duplicates.push(entry.clientId)
				continue
			}
			if (cancelled) {
				refused.push({ clientId: entry.clientId, code: 'count_closed' })
				continue
			}
			const item = byItem.get(entry.itemId)
			if (!item) {
				refused.push({ clientId: entry.clientId, code: 'item_unknown' })
				continue
			}
			if (item.item.archivedAt !== null) {
				refused.push({ clientId: entry.clientId, code: 'item_archived' })
				continue
			}
			if (entry.areaId !== null && !areaIds.has(entry.areaId)) {
				refused.push({ clientId: entry.clientId, code: 'area_unknown' })
				continue
			}
			let quantity = 0
			if (entry.amount !== null) {
				try {
					const typed = typedToBase(
						entry.amount,
						entry.unit,
						item.item.baseUnit,
						item.units,
					)
					quantity = typed.quantity
					if (typed.named) usedUnits.push(typed.named.id)
				} catch (error) {
					if (error instanceof InventoryError) {
						refused.push({
							clientId: entry.clientId,
							code:
								error.code === 'unit_mismatch'
									? 'unit_mismatch'
									: 'quantity_invalid',
						})
						continue
					}
					throw error
				}
			}
			const counter = station ? station.actorFor(entry.clientId) : caller.actor
			const madeAt = station?.madeAt?.(entry.clientId) ?? ctx.now
			if (approved) {
				taken.add(entry.clientId)
				lateRows.push({
					countId: count.id,
					itemId: entry.itemId,
					areaId: entry.areaId,
					quantity,
					enteredAmount: entry.amount === null ? CLEARED : String(entry.amount),
					enteredUnit: storedUnit(entry.unit),
					counterKind: counter.kind,
					counterId: counter.id,
					deviceId: options.device?.id ?? null,
					clientId: entry.clientId,
					countedAt: madeAt,
					receivedAt: ctx.now,
				})
				late.push(entry.clientId)
				accepted.push({
					clientId: entry.clientId,
					quantity: entry.amount === null ? null : quantity,
				})
				continue
			}
			let pass = 1
			if (inSecondPhase) {
				const mine = keyOf.get(actorKey(counter))
				const wasFirst = mine !== undefined && firstKeys.has(mine)
				if (wasFirst && madeAt < (count.secondStartedAt ?? 0)) {
					// A first counter's tablet syncing late: still part of the first count.
					pass = 1
				} else if (wasFirst) {
					refused.push({
						clientId: entry.clientId,
						code: 'second_count_same_person',
					})
					continue
				} else if (!keyItemIds.has(entry.itemId)) {
					refused.push({
						clientId: entry.clientId,
						code: 'second_count_not_key_item',
					})
					continue
				} else {
					pass = 2
				}
			}
			taken.add(entry.clientId)
			rows.push({
				id: newId(),
				countId: count.id,
				itemId: entry.itemId,
				areaId: entry.areaId,
				quantity,
				enteredAmount: entry.amount === null ? CLEARED : String(entry.amount),
				enteredUnit: storedUnit(entry.unit),
				counterKind: counter.kind,
				counterId: counter.id,
				clientId: entry.clientId,
				pass,
				createdAt: madeAt,
			})
			accepted.push({
				clientId: entry.clientId,
				quantity: entry.amount === null ? null : quantity,
			})
		}
		await insertRowsInChunks(invCountEntries, rows, (chunk) =>
			tx.insert(invCountEntries).values(chunk),
		)
		await storeLateEntries(tx, lateRows)
		await markUnitsUsed(tx, usedUnits, ctx.now)
		if (options.device && !approved && !cancelled) {
			await recordCountDevice(tx, {
				countId: count.id,
				device: options.device,
				person: caller.actor,
				now: ctx.now,
			})
		}
		if (lateRows.length > 0) {
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count.late_entries',
				resourceType: 'count',
				resourceId: count.id,
				locationId: count.locationId,
				detail: { entries: lateRows.length },
				at: ctx.now,
			})
		}
		if (rows.length > 0) {
			// One audit row per person the entries are counted for.
			const byCounter = new Map<
				string,
				{ actor: InventoryActor; entries: number }
			>()
			for (const row of rows) {
				const key = `${row.counterKind}|${row.counterId ?? ''}`
				const found = byCounter.get(key)
				if (found) found.entries += 1
				else {
					byCounter.set(key, {
						actor: { kind: row.counterKind!, id: row.counterId ?? null },
						entries: 1,
					})
				}
			}
			for (const { actor, entries: n } of byCounter.values()) {
				await recordInventoryAudit(tx, {
					actorKind: actor.kind,
					actorId: actor.id,
					action: 'count.entries',
					resourceType: 'count',
					resourceId: count.id,
					locationId: count.locationId,
					detail:
						station && actor.id !== station.syncedBy
							? { entries: n, syncedBy: station.syncedBy }
							: { entries: n },
					at: ctx.now,
				})
			}
		}
		return late.length > 0
			? { accepted, duplicates, refused, late }
			: { accepted, duplicates, refused }
	})
}

/**
 * What moved each item between the last approved count at the location (its
 * instant, see `countInstant`) and the moment the item was counted (`until`;
 * null = no bound, for an item nobody counted), so "expected" explains itself
 * (see `countReviewMovementsSchema`). Movements after `until` are not part of
 * the as-of expected and are left out. One read per 90 items, only for the
 * lines a person has to look at.
 */
async function reviewMovements(
	db: InventoryReader,
	input: {
		locationId: string
		items: ReadonlyArray<{ itemId: string; until: number | null }>
	},
): Promise<Map<string, CountReview['lines'][number]['movements']>> {
	const result = new Map<string, CountReview['lines'][number]['movements']>()
	if (input.items.length === 0) return result
	const last = await db
		.select({ id: invCounts.id, approvedAt: invCounts.approvedAt })
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, input.locationId),
				eq(invCounts.status, 'approved'),
			),
		)
		.orderBy(desc(invCounts.approvedAt), desc(invCounts.id))
		.limit(1)
		.get()
	const since = last
		? ((await countInstants(db, [last.id])).get(last.id) ?? last.approvedAt)
		: null
	const until = new Map(input.items.map((item) => [item.itemId, item.until]))
	const rows = await queryInChunks(
		input.items.map((item) => item.itemId),
		(chunk) =>
			db
				.select({
					itemId: invMovements.itemId,
					kind: invMovements.kind,
					quantity: invMovements.quantity,
					createdAt: invMovements.createdAt,
				})
				.from(invMovements)
				.where(
					and(
						eq(invMovements.locationId, input.locationId),
						gt(invMovements.createdAt, since ?? -1),
						inArray(invMovements.itemId, chunk),
					),
				),
	)
	for (const item of input.items) {
		result.set(item.itemId, {
			since,
			delivered: 0,
			used: 0,
			wasted: 0,
			adjusted: 0,
		})
	}
	for (const row of rows) {
		const bound = until.get(row.itemId) ?? null
		if (bound !== null && row.createdAt > bound) continue
		const out = result.get(row.itemId)!
		const total = row.quantity
		if (row.kind === 'delivery' || row.kind === 'transfer_in') {
			out.delivered += total
		} else if (row.kind === 'batch_made') {
			out.delivered += total
		} else if (row.kind === 'sale' || row.kind === 'batch_used') {
			out.used += -total
		} else if (row.kind === 'transfer_out') {
			out.used += -total
		} else if (row.kind === 'waste') {
			out.wasted += -total
		} else if (row.kind === 'adjustment') {
			out.adjusted += total
		}
	}
	return result
}

// ── Review and approve ──────────────────────────────────────────────────────

export async function getCountReview(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller; now?: number },
): Promise<CountReview> {
	const { caller } = input
	const row = await loadAllowedCount(db, input.id, caller)
	if (row.status !== 'counting' && row.status !== 'in_review') {
		throw new InventoryError('count_closed', 409)
	}
	const [entries, stock] = await Promise.all([
		loadEntries(db, [row.id]),
		loadLocationStock(db, row.locationId),
	])
	const { scope, data } = await reviewInputs(
		db,
		row,
		entries.get(row.id) ?? [],
		stock,
	)
	const flagged = data.filter((line) => line.flag !== null)
	// Big differences first: the ones with a known money value (largest first),
	// then the rest by how far off they are from what was expected.
	const share = (line: ReviewLineData) =>
		line.expected === 0
			? Number.MAX_SAFE_INTEGER
			: Math.abs(line.difference ?? 0) / Math.abs(line.expected)
	flagged.sort((a, b) => {
		if (a.flag !== b.flag) return a.flag === 'big_difference' ? -1 : 1
		if ((a.valueMinor === null) !== (b.valueMinor === null)) {
			return a.valueMinor === null ? 1 : -1
		}
		return (
			Math.abs(b.valueMinor ?? 0) - Math.abs(a.valueMinor ?? 0) ||
			share(b) - share(a) ||
			a.row.item.name.toLowerCase().localeCompare(b.row.item.name.toLowerCase())
		)
	})
	const currency = stockCurrency(scope)
	const movements = await reviewMovements(db, {
		locationId: row.locationId,
		items: flagged.map((line) => ({
			itemId: line.row.item.id,
			until: line.countedAt,
		})),
	})
	const review: CountReview = {
		count: (await summarize(db, [row], caller))[0]!,
		lines: flagged.map((line) => {
			const out: CountReview['lines'][number] = {
				itemId: line.row.item.id,
				name: line.row.item.name,
				baseUnit: line.row.item.baseUnit,
				countUnit: line.row.place?.countUnit
					? wireUnit(line.row.place.countUnit)
					: wireUnit('piece'),
				units: line.row.units.map(toItemUnit),
				counted: line.counted,
				expected: line.expected,
				difference: line.difference,
				flag: line.flag!,
			}
			const moved = movements.get(line.row.item.id)
			if (moved) out.movements = moved
			if (caller.cost && line.valueMinor !== null) {
				out.differenceValueMinor = line.valueMinor
				if (line.row.cost) out.currency = line.row.cost.currency
			}
			return out
		}),
		matching: data.filter((line) => line.flag === null).length,
		notCounted: data.filter((line) => line.flag === 'not_counted').length,
	}
	if (caller.cost) {
		review.differenceValueMinor = netDifference(data)
		// The money gap of the key items alone since the last count (#490).
		review.keyDifferenceValueMinor = netDifference(
			data.filter((line) => line.row.item.isKey),
		)
		if (currency) review.currency = currency
	}
	// Who is still counting (#474) and the second check beside the first (#525).
	review.devices = await listCountDevices(db, row.id, input.now ?? Date.now())
	if (row.secondState !== null) {
		review.second = await buildSecondCheck(
			db,
			row,
			entries.get(row.id) ?? [],
			stock,
		)
	}
	return review
}

export async function approveCount(
	caller: InventoryCaller,
	input: { id: string; body: ApproveCountInput },
) {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedCount(tx, input.id, caller)
		assertVersion(row.version, input.body.expectedVersion)
		if (row.status === 'approved' || row.status === 'cancelled') {
			throw new InventoryError('count_closed', 409)
		}
		if (row.status !== 'in_review') throw stateConflict('not_in_review')
		// Devices that joined and have not said they are done: the manager decides
		// (#474). Entries that reach the count later are kept as late entries.
		const devices = await listCountDevices(tx, row.id, ctx.now)
		const pending = devices.filter((device) => device.state !== 'done')
		if (pending.length > 0 && !input.body.approveAnyway) {
			throw new InventoryError('devices_still_counting', 409, {
				devices: pending.map((device) => ({
					deviceId: device.deviceId,
					name: device.name,
					unsentCount: device.unsentCount,
					state: device.state,
				})),
			})
		}
		const [entries, stock, settings] = await Promise.all([
			loadEntries(tx, [row.id]),
			loadLocationStock(tx, row.locationId),
			getInventorySettings(tx, caller.region),
		])
		// The rule: counted vs the ledger as of each item's latest entry (see
		// `expectedAsOf`), so a delivery between counting and approving survives.
		// An item nobody counted follows `uncounted`: `zero` removes the live
		// on-hand as of now.
		const { data } = await reviewInputs(
			tx,
			row,
			entries.get(row.id) ?? [],
			stock,
		)
		let adjusted = 0
		let superseded = 0
		let net = 0
		let currency: string | undefined
		for (const line of data) {
			let target: number | null = line.counted
			if (target === null) {
				target = input.body.uncounted[line.row.item.id] === 'zero' ? 0 : null
			}
			if (target === null) continue
			if (line.superseded) {
				superseded++
				continue
			}
			const difference = target - line.expected
			if (difference === 0) continue
			const avg = line.row.cost?.avgCostMicro ?? null
			const value = avg === null ? null : inventoryValueMinor(difference, avg)
			const note = input.body.notes[line.row.item.id]
			await tx.insert(invMovements).values({
				id: newId(),
				locationId: row.locationId,
				itemId: line.row.item.id,
				quantity: difference,
				valueMinor: value,
				currency: value === null ? null : line.row.cost!.currency,
				kind: 'count',
				reason: null,
				sourceType: 'count',
				sourceId: row.id,
				eventKey: `count:${row.id}:${line.row.item.id}`,
				businessDate: row.businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				note: note?.length ? note : null,
				// Stamped with the instant the item was counted, so the ledger up to
				// that instant already holds the counted figure (food cost reads it
				// so). An uncounted item set to zero is posted now.
				createdAt: line.countedAt ?? ctx.now,
			})
			adjusted++
			if (value !== null) {
				net += value
				currency ??= line.row.cost!.currency
			}
		}
		await tx
			.update(invCounts)
			.set({
				status: 'approved',
				approvedAt: ctx.now,
				approvedById: caller.actor.id,
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count.approve',
			resourceType: 'count',
			resourceId: row.id,
			locationId: row.locationId,
			detail: {
				adjustedItems: adjusted,
				differenceValueMinor: net,
				supersededItems: superseded,
			},
			at: ctx.now,
		})
		const result: {
			count: CountSummary
			adjustedItems: number
			differenceValueMinor: number
			currency?: string
			foodCost: Awaited<ReturnType<typeof computeFoodCost>>
		} = {
			count: (await summarize(tx, [await loadCount(tx, row.id)], caller))[0]!,
			adjustedItems: adjusted,
			differenceValueMinor: net,
			foodCost: await computeFoodCost(tx, {
				locationId: row.locationId,
				targetBp: settings.targetFoodCostBp,
			}),
		}
		if (currency) result.currency = currency
		return result
	})
}

// ── Second-person check of key items (#525) ─────────────────────────────────

/**
 * Whether sending this count must wait for a second person: the location asked
 * for it and the count includes key items.
 */
async function needsSecondCheck(
	db: InventoryReader,
	row: CountRow,
): Promise<boolean> {
	const controls = await getLocationCountControls(db, row.locationId)
	if (!controls.secondCountRequired) return false
	const stock = await loadLocationStock(db, row.locationId)
	const scope = await countScope(db, row, stock)
	return scope.some((entry) => entry.item.isKey)
}

/** The ids of the key items this count includes. */
async function keyItemIdsOf(
	db: InventoryReader,
	row: CountRow,
): Promise<Set<string>> {
	const stock = await loadLocationStock(db, row.locationId)
	const scope = await countScope(db, row, stock)
	return new Set(
		scope.filter((entry) => entry.item.isKey).map((entry) => entry.item.id),
	)
}

/** The people who made the count's first-pass entries. */
function firstCounters(entries: readonly EntryRow[]): InventoryActor[] {
	const seen = new Map<string, InventoryActor>()
	for (const entry of firstPass(entries)) {
		const actor = { kind: entry.counterKind, id: entry.counterId }
		seen.set(actorKey(actor), actor)
	}
	return [...seen.values()]
}

/**
 * The second person's count beside the first, key item by key item. Lines list
 * only the items where the two disagree; `keyItemCount` says how many were
 * compared. Before the second person has finished (`waiting`) there are no
 * lines: nobody sees the first figures while counting (blind).
 */
async function buildSecondCheck(
	db: InventoryReader,
	row: CountRow,
	entries: readonly EntryRow[],
	stock: StockRow[],
): Promise<CountSecondCheck> {
	const scope = await countScope(db, row, stock)
	const keyItems = scope.filter((entry) => entry.item.isKey)
	const secondEntries = secondPass(entries)
	const secondLive = liveEntries(secondEntries)
	const secondCounters: CountSecondCheck['secondCounters'] = []
	const seen = new Set<string>()
	for (const entry of secondEntries) {
		const key = `${entry.counterKind}|${entry.counterId ?? ''}`
		if (seen.has(key)) continue
		seen.add(key)
		secondCounters.push({ kind: entry.counterKind, id: entry.counterId })
	}
	const base: CountSecondCheck = {
		state: row.secondState,
		keyItemCount: row.secondState === null ? 0 : keyItems.length,
		secondCounters,
		lines: [],
		skipReason: row.secondSkipReason,
	}
	if (row.secondState === null || row.secondState === 'waiting') return base
	const saved = await db
		.select()
		.from(invCountSecondChecks)
		.where(eq(invCountSecondChecks.countId, row.id))
	const byItem = new Map(saved.map((check) => [check.itemId, check]))
	const firstTotals = countedTotals(liveEntries(firstPass(entries)))
	const secondTotals = countedTotals(secondLive)
	for (const entry of keyItems) {
		const id = entry.item.id
		const check = byItem.get(id)
		const first = check?.firstQuantity ?? firstTotals.get(id) ?? null
		const second = check ? check.secondQuantity : (secondTotals.get(id) ?? null)
		if (first === second) continue
		const resolution = check?.resolution
		base.lines.push({
			itemId: id,
			name: entry.item.name,
			baseUnit: entry.item.baseUnit,
			firstQuantity: first,
			secondQuantity: second,
			matches: false,
			resolution:
				resolution === 'first' || resolution === 'second' ? resolution : null,
		})
	}
	return base
}

export async function getSecondCheck(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
): Promise<CountSecondCheck> {
	const row = await loadAllowedCount(db, input.id, input.caller)
	const [entries, stock] = await Promise.all([
		loadEntries(db, [row.id]),
		loadLocationStock(db, row.locationId),
	])
	return buildSecondCheck(db, row, entries.get(row.id) ?? [], stock)
}

/** Moves the count on once the second check is settled (or skipped): it reaches review. */
function toReview(now: number): Partial<typeof invCounts.$inferInsert> {
	return { status: 'in_review', sentForReviewAt: now }
}

/**
 * The second person is done counting the key items: the two counts are
 * compared. No difference: the check is done and the count goes to review.
 * Differences: they are stored side by side and wait to be settled.
 */
export async function finishSecondCheck(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number },
): Promise<CountSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedCount(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status !== 'counting' || row.secondState !== 'waiting') {
			throw stateConflict('not_waiting_for_second')
		}
		const [entries, stock] = await Promise.all([
			loadEntries(tx, [row.id]),
			loadLocationStock(tx, row.locationId),
		])
		const all = entries.get(row.id) ?? []
		if (secondPass(all).length === 0) {
			// Nobody counted yet: finishing would compare against nothing.
			throw new InventoryError('second_count_pending', 409, {
				reason: 'nobody_counted',
			})
		}
		const scope = await countScope(tx, row, stock)
		const firstTotals = countedTotals(liveEntries(firstPass(all)))
		const secondLive = liveEntries(secondPass(all))
		const secondTotals = countedTotals(secondLive)
		const secondAt = countedAtByItem(secondLive)
		let differing = 0
		await tx
			.delete(invCountSecondChecks)
			.where(eq(invCountSecondChecks.countId, row.id))
		for (const entry of scope.filter((candidate) => candidate.item.isKey)) {
			const id = entry.item.id
			const first = firstTotals.get(id) ?? null
			const second = secondTotals.get(id) ?? null
			if (first !== second) differing += 1
			await tx.insert(invCountSecondChecks).values({
				countId: row.id,
				itemId: id,
				firstQuantity: first,
				secondQuantity: second,
				secondCountedAt: secondAt.get(id) ?? null,
				createdAt: ctx.now,
			})
		}
		const set: Partial<typeof invCounts.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (differing === 0) {
			set.secondState = 'done'
			Object.assign(set, toReview(ctx.now))
		} else {
			set.secondState = 'settling'
		}
		await tx.update(invCounts).set(set).where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count.second_finish',
			resourceType: 'count',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { differing },
			at: ctx.now,
		})
		return (await summarize(tx, [await loadCount(tx, row.id)], caller))[0]!
	})
}

/**
 * Settles the differences: for each item the first or the second figure
 * stands. When none is left the check is done and the count goes to review.
 */
export async function settleSecondCheck(
	caller: InventoryCaller,
	input: {
		id: string
		expectedVersion: number
		resolutions: Record<string, 'first' | 'second'>
	},
): Promise<CountSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedCount(tx, input.id, caller)
		assertVersion(row.version, input.expectedVersion)
		if (row.status !== 'counting' || row.secondState !== 'settling') {
			throw stateConflict('not_settling')
		}
		const checks = await tx
			.select()
			.from(invCountSecondChecks)
			.where(eq(invCountSecondChecks.countId, row.id))
		const byItem = new Map(checks.map((check) => [check.itemId, check]))
		for (const [itemId, resolution] of Object.entries(input.resolutions)) {
			const check = byItem.get(itemId)
			if (!check || check.firstQuantity === check.secondQuantity) {
				throw new InventoryError('invalid_request', 400, {
					reason: 'nothing_to_settle',
				})
			}
			if (resolution === 'second' && check.secondQuantity === null) {
				throw new InventoryError('invalid_request', 400, {
					reason: 'second_not_counted',
				})
			}
			await tx
				.update(invCountSecondChecks)
				.set({
					resolution,
					resolvedById: caller.actor.id,
					resolvedAt: ctx.now,
				})
				.where(
					and(
						eq(invCountSecondChecks.countId, row.id),
						eq(invCountSecondChecks.itemId, itemId),
					),
				)
			check.resolution = resolution
		}
		const open = checks.filter(
			(check) =>
				check.firstQuantity !== check.secondQuantity &&
				check.resolution === null,
		)
		const set: Partial<typeof invCounts.$inferInsert> = {
			version: row.version + 1,
			updatedAt: ctx.now,
		}
		if (open.length === 0) {
			set.secondState = 'done'
			Object.assign(set, toReview(ctx.now))
		}
		await tx.update(invCounts).set(set).where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count.second_settle',
			resourceType: 'count',
			resourceId: row.id,
			locationId: row.locationId,
			detail: {
				settled: Object.keys(input.resolutions).length,
				open: open.length,
			},
			at: ctx.now,
		})
		return (await summarize(tx, [await loadCount(tx, row.id)], caller))[0]!
	})
}

/**
 * A manager skips the second check with a reason (kept on the count and in the
 * audit trail). The count goes to review as it stands.
 */
export async function skipSecondCheck(
	caller: InventoryCaller,
	input: { id: string; expectedVersion: number; reason: string },
): Promise<CountSummary> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const row = await loadAllowedCount(tx, input.id, caller)
		// A manager's decision (`update:settings:any`): checked after the count is
		// found, so a count of another organization or location answers as before.
		if (!caller.canManageSettings || caller.actor.kind !== 'operator') {
			throw new InventoryError('forbidden', 403, { reason: 'grant' })
		}
		assertVersion(row.version, input.expectedVersion)
		if (
			row.status !== 'counting' ||
			(row.secondState !== 'waiting' && row.secondState !== 'settling')
		) {
			throw stateConflict('not_waiting_for_second')
		}
		await tx
			.update(invCounts)
			.set({
				secondState: 'skipped',
				secondSkipReason: input.reason,
				secondSkippedBy: caller.actor.id,
				...toReview(ctx.now),
				version: row.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'count.second_skip',
			resourceType: 'count',
			resourceId: row.id,
			locationId: row.locationId,
			detail: { reason: input.reason },
			at: ctx.now,
		})
		return (await summarize(tx, [await loadCount(tx, row.id)], caller))[0]!
	})
}
