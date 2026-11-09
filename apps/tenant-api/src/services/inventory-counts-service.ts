import {
	inventoryValueMinor,
	needsReview,
	type CountReview,
	type CountSheet,
	type CountSummary,
	type UnitRef,
} from '@repo/inventory'
import {
	invCountEntries,
	invCountListItems,
	invCountLists,
	invCounts,
	invItems,
	invMovements,
	invStorageAreas,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { insertRowsInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	decodeCursor,
	defaultCountUnit,
	encodeCursor,
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
import { computeFoodCost } from './inventory-food-cost.ts'
import {
	type InventoryCaller,
	loadLocationStock,
	type StockRow,
	toItemUnit,
} from './inventory-items-service.ts'
import { getInventorySettings } from './inventory-settings-service.ts'

type CountRow = typeof invCounts.$inferSelect
type EntryRow = typeof invCountEntries.$inferSelect

const OPEN_STATUSES = ['counting', 'in_review'] as const

// ── Entries ─────────────────────────────────────────────────────────────────

/** An entry that clears its counter's earlier entry has no amount. */
const CLEARED = ''

function liveKey(row: EntryRow): string {
	return [
		row.itemId,
		row.areaId ?? '',
		row.counterKind,
		row.counterId ?? '',
		row.enteredUnit,
	].join('|')
}

/**
 * The live entries: the latest per item, area, counter and entered unit
 * (`rows` oldest first); an entry that cleared its predecessor drops out.
 */
export function liveEntries(rows: readonly EntryRow[]): EntryRow[] {
	const latest = new Map<string, EntryRow>()
	for (const row of rows) latest.set(liveKey(row), row)
	return [...latest.values()].filter((row) => row.enteredAmount !== CLEARED)
}

async function loadEntries(
	db: InventoryReader,
	countIds: readonly string[],
): Promise<Map<string, EntryRow[]>> {
	const rows = await queryInChunks(countIds, (chunk) =>
		db
			.select()
			.from(invCountEntries)
			.where(inArray(invCountEntries.countId, chunk))
			.orderBy(invCountEntries.createdAt, sql`rowid`),
	)
	const map = new Map<string, EntryRow[]>()
	for (const row of rows) {
		const list = map.get(row.countId)
		if (list) list.push(row)
		else map.set(row.countId, [row])
	}
	return map
}

/** Counted base quantity per item (sum of live entries); items nobody counted are absent. */
function countedTotals(live: readonly EntryRow[]): Map<string, number> {
	const totals = new Map<string, number>()
	for (const row of live) {
		totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.quantity)
	}
	return totals
}

// ── Scope and review ────────────────────────────────────────────────────────

async function countScope(
	db: InventoryReader,
	count: CountRow,
	stock: StockRow[],
): Promise<StockRow[]> {
	if (!count.listId) return stock.filter((row) => row.place !== null)
	const rows = await db
		.select({ itemId: invCountListItems.itemId })
		.from(invCountListItems)
		.where(eq(invCountListItems.listId, count.listId))
	const wanted = new Set(rows.map((row) => row.itemId))
	return stock.filter((row) => wanted.has(row.item.id))
}

type ReviewLineData = {
	row: StockRow
	counted: number | null
	expected: number
	difference: number | null
	valueMinor: number | null
	flag: 'not_counted' | 'big_difference' | null
}

function reviewData(
	scope: readonly StockRow[],
	totals: ReadonlyMap<string, number>,
): ReviewLineData[] {
	return scope.map((row) => {
		const counted = totals.get(row.item.id) ?? null
		const expected = row.onHand
		if (counted === null) {
			return {
				row,
				counted,
				expected,
				difference: null,
				valueMinor: null,
				flag: 'not_counted' as const,
			}
		}
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
		return { row, counted, expected, difference, valueMinor, flag }
	})
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
	const [entries, lists, posted] = await Promise.all([
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
	])
	const listName = new Map(lists.map((row) => [row.id, row.name]))
	const postedByCount = new Map(posted.map((row) => [row.countId, row]))
	const stockByLocation = new Map<string, StockRow[]>()
	const result: CountSummary[] = []
	for (const row of rows) {
		const live = liveEntries(entries.get(row.id) ?? [])
		const totals = countedTotals(live)
		const counters: CountSummary['counters'] = []
		const seen = new Set<string>()
		for (const entry of entries.get(row.id) ?? []) {
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
				difference = {
					valueMinor: netDifference(reviewData(scope, totals)),
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
		}
		if (difference) {
			summary.differenceValueMinor = difference.valueMinor
			if (difference.currency) summary.currency = difference.currency
		}
		result.push(summary)
	}
	return result
}

async function loadCount(db: InventoryReader, id: string): Promise<CountRow> {
	const row = await db
		.select()
		.from(invCounts)
		.where(eq(invCounts.id, id))
		.get()
	if (!row) throw notFound()
	return row
}

/** A count the token's locations allow (404 for a missing one, 403 for an excluded location). */
async function loadAllowedCount(
	db: InventoryReader,
	id: string,
	caller: Pick<InventoryCaller, 'locationIds'>,
): Promise<CountRow> {
	const row = await loadCount(db, id)
	assertLocationAllowed(caller.locationIds, row.locationId)
	return row
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

export async function startCount(
	caller: InventoryCaller,
	input: {
		clientId: string
		locationId: string
		listId: string | null
		idempotency: InventoryIdempotency
	},
): Promise<CountSummary> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
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
			const open = await tx
				.select({ id: invCounts.id })
				.from(invCounts)
				.where(
					and(
						eq(invCounts.locationId, input.locationId),
						inArray(invCounts.status, [...OPEN_STATUSES]),
						input.listId
							? eq(invCounts.listId, input.listId)
							: isNull(invCounts.listId),
					),
				)
				.limit(1)
				.get()
			if (open) {
				throw new InventoryError('count_in_progress', 409, { countId: open.id })
			}
			const id = newId()
			await tx.insert(invCounts).values({
				id,
				locationId: input.locationId,
				listId: input.listId,
				status: 'counting',
				businessDate: await locationBusinessDate(tx, input.locationId, ctx.now),
				startedByKind: caller.actor.kind,
				startedById: caller.actor.id,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count.start',
				resourceType: 'count',
				resourceId: id,
				locationId: input.locationId,
				at: ctx.now,
			})
			return (await summarize(tx, [await loadCount(tx, id)], caller))[0]!
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
		if (input.action === 'send') {
			if (row.status !== 'counting') throw stateConflict('not_counting')
			set.status = 'in_review'
			set.sentForReviewAt = ctx.now
		} else if (input.action === 'reopen') {
			if (row.status !== 'in_review') throw stateConflict('not_in_review')
			set.status = 'counting'
			set.sentForReviewAt = null
		} else {
			set.status = 'cancelled'
			set.cancelledAt = ctx.now
		}
		await tx.update(invCounts).set(set).where(eq(invCounts.id, row.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: `count.${input.action}`,
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
	const live = liveEntries(entries.get(row.id) ?? [])
	const scope = await countScope(db, row, stock)

	const quantity = new Map<string, number>()
	const mine = new Map<string, { amount: number; unit: UnitRef }>()
	for (const entry of live) {
		const key = `${entry.itemId}|${entry.areaId ?? ''}`
		quantity.set(key, (quantity.get(key) ?? 0) + entry.quantity)
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
		areas: sheetAreas,
	}
}

// ── Entries ─────────────────────────────────────────────────────────────────

export async function addCountEntries(
	caller: InventoryCaller,
	input: { id: string; body: CountEntriesInput },
) {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const count = await loadAllowedCount(tx, input.id, caller)
		const accepted: Array<{ clientId: string; quantity: number | null }> = []
		const duplicates: string[] = []
		const refused: Array<{ clientId: string; code: string }> = []
		const { entries } = input.body
		if (count.status !== 'counting') {
			return {
				accepted,
				duplicates,
				refused: entries.map((entry) => ({
					clientId: entry.clientId,
					code: 'count_closed',
				})),
			}
		}
		const clientIds = entries.map((entry) => entry.clientId)
		const existing = await queryInChunks(clientIds, (chunk) =>
			tx
				.select({ clientId: invCountEntries.clientId })
				.from(invCountEntries)
				.where(inArray(invCountEntries.clientId, chunk)),
		)
		const taken = new Set(existing.map((row) => row.clientId))
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
			if (taken.has(entry.clientId)) {
				duplicates.push(entry.clientId)
				continue
			}
			const item = byItem.get(entry.itemId)
			if (!item || item.item.archivedAt !== null) {
				refused.push({ clientId: entry.clientId, code: 'not_found' })
				continue
			}
			if (entry.areaId !== null && !areaIds.has(entry.areaId)) {
				refused.push({ clientId: entry.clientId, code: 'not_found' })
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
						refused.push({ clientId: entry.clientId, code: error.code })
						continue
					}
					throw error
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
				counterKind: caller.actor.kind,
				counterId: caller.actor.id,
				clientId: entry.clientId,
				createdAt: ctx.now,
			})
			accepted.push({
				clientId: entry.clientId,
				quantity: entry.amount === null ? null : quantity,
			})
		}
		await insertRowsInChunks(invCountEntries, rows, (chunk) =>
			tx.insert(invCountEntries).values(chunk),
		)
		await markUnitsUsed(tx, usedUnits, ctx.now)
		if (rows.length > 0) {
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'count.entries',
				resourceType: 'count',
				resourceId: count.id,
				locationId: count.locationId,
				detail: { entries: rows.length },
				at: ctx.now,
			})
		}
		return { accepted, duplicates, refused }
	})
}

// ── Review and approve ──────────────────────────────────────────────────────

export async function getCountReview(
	db: InventoryReader,
	input: { id: string; caller: InventoryCaller },
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
	const totals = countedTotals(liveEntries(entries.get(row.id) ?? []))
	const scope = await countScope(db, row, stock)
	const data = reviewData(scope, totals)
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
		if (currency) review.currency = currency
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
		const [entries, stock, settings] = await Promise.all([
			loadEntries(tx, [row.id]),
			loadLocationStock(tx, row.locationId),
			getInventorySettings(tx, caller.region),
		])
		const totals = countedTotals(liveEntries(entries.get(row.id) ?? []))
		const scope = await countScope(tx, row, stock)
		let adjusted = 0
		let net = 0
		let currency: string | undefined
		for (const line of reviewData(scope, totals)) {
			let target: number | null = line.counted
			if (target === null) {
				target = input.body.uncounted[line.row.item.id] === 'zero' ? 0 : null
			}
			if (target === null) continue
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
				createdAt: ctx.now,
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
			detail: { adjustedItems: adjusted, differenceValueMinor: net },
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
