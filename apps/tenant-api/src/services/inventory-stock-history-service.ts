import {
	inventoryValueMinorClamped,
	STOCK_DAY_COLUMNS,
	type StockDay,
	type StockDayColumn,
	type StockDayRow,
	type StockOnDate,
	type StockOnDateItem,
} from '@repo/inventory'
import {
	invCostEvents,
	invItemPlaces,
	invItems,
	invMovements,
} from '@repo/tenant-db'
import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm'
import { addDays, businessDayStartMs } from '@repo/reservations'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import {
	assertLocationAllowed,
	locationClock,
	wireUnit,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { resolveLocationTime } from './inventory-location-settings.ts'

/**
 * Stock and stock value on any past business day (#521): a read model over the
 * append-only ledger, nothing stored (see `contract/stock-history.ts` for the
 * rules). The same two functions feed the Stock date picker, the day view and
 * the month-end export, so the three can never disagree.
 */

type ItemRef = {
	id: string
	name: string
	category: string
	baseUnit: 'g' | 'ml' | 'piece'
}

/** `kind` of a movement, as a column of the day view. */
const COLUMN_OF_KIND: Record<string, Exclude<StockDayColumn, 'opening' | 'closing' | 'transfersIn' | 'transfersOut'>> =
	{
		delivery: 'delivered',
		sale: 'used',
		waste: 'wasted',
		adjustment: 'adjustments',
		count: 'countCorrections',
		batch_made: 'made',
		batch_used: 'prepUsed',
	}

function columnOf(kind: string): StockDayColumn {
	if (kind === 'transfer_in') return 'transfersIn'
	if (kind === 'transfer_out') return 'transfersOut'
	const column = COLUMN_OF_KIND[kind]
	if (!column) throw new Error(`unknown movement kind ${kind}`)
	return column
}

const zeroColumns = (): Record<StockDayColumn, number> =>
	Object.fromEntries(STOCK_DAY_COLUMNS.map((c) => [c, 0])) as Record<
		StockDayColumn,
		number
	>

type CostEvent = { at: number; avgMicro: number }

/** An item's average cost history, oldest first. */
async function loadCostHistory(
	db: InventoryReader,
	itemIds: readonly string[],
): Promise<Map<string, CostEvent[]>> {
	const rows = await queryInChunks(itemIds, (chunk) =>
		db
			.select({
				itemId: invCostEvents.itemId,
				at: invCostEvents.createdAt,
				avgMicro: invCostEvents.avgAfterMicro,
			})
			.from(invCostEvents)
			.where(inArray(invCostEvents.itemId, chunk))
			.orderBy(invCostEvents.createdAt, invCostEvents.id),
	)
	const map = new Map<string, CostEvent[]>()
	for (const row of rows) {
		const list = map.get(row.itemId)
		const event = { at: row.at, avgMicro: row.avgMicro }
		if (list) list.push(event)
		else map.set(row.itemId, [event])
	}
	return map
}

/**
 * The average cost in force at the end of an instant: the last step at or
 * before it. Stock that came in with no price (a quantity-only delivery) was
 * priced later: with no cost known by then, the first one known after it is
 * used, so a month-end figure asked for days later is not short. An item that
 * has never had a cost has none.
 */
function averageAt(history: CostEvent[] | undefined, endMs: number): number | null {
	if (!history || history.length === 0) return null
	let found: number | null = null
	for (const event of history) {
		if (event.at > endMs) break
		found = event.avgMicro
	}
	return found ?? history[0]!.avgMicro
}

type Clock = {
	today: string
	timeZone: string
	dayStartMin: number
	endOfDay: (date: string) => number
}

async function clockFor(
	db: InventoryReader,
	locationId: string,
	now: number,
): Promise<Clock> {
	const [clock, time] = await Promise.all([
		locationClock(db, locationId, now),
		resolveLocationTime(db, locationId),
	])
	const timeZone = time.timeZone ?? 'UTC'
	return {
		today: clock.date,
		timeZone,
		dayStartMin: time.dayStartMin,
		// The business day ends where the next one starts.
		endOfDay: (date) =>
			businessDayStartMs(addDays(date, 1), timeZone, time.dayStartMin) - 1,
	}
}

type Sums = {
	/** item -> quantity */
	qty: Map<string, number>
	/** item -> money (valued movements, plus the unvalued ones at the day's average) */
	money: Map<string, number>
	/** items with stock on hand and some movement left unpriced */
	unpriced: Set<string>
}

/**
 * Per item, the quantity and money of every movement up to (and including, or
 * before) a business date.
 */
async function sumMovements(
	db: InventoryReader,
	input: {
		locationId: string
		date: string
		inclusive: boolean
		clock: Clock
		history: Map<string, CostEvent[]>
		itemId?: string
	},
): Promise<Sums> {
	const dateCondition = input.inclusive
		? lte(invMovements.businessDate, input.date)
		: lt(invMovements.businessDate, input.date)
	const scope = and(
		eq(invMovements.locationId, input.locationId),
		dateCondition,
		input.itemId ? eq(invMovements.itemId, input.itemId) : undefined,
	)
	const totals = await db
		.select({
			itemId: invMovements.itemId,
			qty: sql<number>`sum(${invMovements.quantity})`,
			valued: sql<number>`sum(case when ${invMovements.valueMinor} is null then 0 else ${invMovements.valueMinor} end)`,
		})
		.from(invMovements)
		.where(scope)
		.groupBy(invMovements.itemId)
	// Movements with no value of their own, valued at the average of their day.
	const unvalued = await db
		.select({
			itemId: invMovements.itemId,
			businessDate: invMovements.businessDate,
			qty: sql<number>`sum(${invMovements.quantity})`,
		})
		.from(invMovements)
		.where(and(scope, sql`${invMovements.valueMinor} is null`))
		.groupBy(invMovements.itemId, invMovements.businessDate)
	const qty = new Map<string, number>()
	const money = new Map<string, number>()
	const unpriced = new Set<string>()
	for (const row of totals) {
		qty.set(row.itemId, Number(row.qty ?? 0))
		money.set(row.itemId, Number(row.valued ?? 0))
	}
	for (const row of unvalued) {
		const quantity = Number(row.qty ?? 0)
		if (quantity === 0) continue
		const average = averageAt(
			input.history.get(row.itemId),
			input.clock.endOfDay(row.businessDate),
		)
		if (average === null) {
			unpriced.add(row.itemId)
			continue
		}
		money.set(
			row.itemId,
			(money.get(row.itemId) ?? 0) + inventoryValueMinorClamped(quantity, average),
		)
	}
	return { qty, money, unpriced }
}

async function unvaluedItemIds(
	db: InventoryReader,
	locationId: string,
	upTo: string,
	itemId?: string,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ itemId: invMovements.itemId })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, locationId),
				lte(invMovements.businessDate, upTo),
				sql`${invMovements.valueMinor} is null`,
				itemId ? eq(invMovements.itemId, itemId) : undefined,
			),
		)
	return rows.map((row) => row.itemId)
}

async function loadItemRefs(
	db: InventoryReader,
	locationId: string,
	itemIds: readonly string[],
): Promise<{
	items: Map<string, ItemRef>
	countUnits: Map<string, string | null>
}> {
	const [items, places] = await Promise.all([
		queryInChunks(itemIds, (chunk) =>
			db
				.select({
					id: invItems.id,
					name: invItems.name,
					category: invItems.category,
					baseUnit: invItems.baseUnit,
				})
				.from(invItems)
				.where(inArray(invItems.id, chunk)),
		),
		queryInChunks(itemIds, (chunk) =>
			db
				.select({
					itemId: invItemPlaces.itemId,
					countUnit: invItemPlaces.countUnit,
				})
				.from(invItemPlaces)
				.where(
					and(
						eq(invItemPlaces.locationId, locationId),
						inArray(invItemPlaces.itemId, chunk),
					),
				),
		),
	])
	return {
		items: new Map(items.map((row) => [row.id, row])),
		countUnits: new Map(places.map((row) => [row.itemId, row.countUnit])),
	}
}

function assertDate(date: string, today: string): void {
	if (date > today) throw new InventoryError('invalid_request', 400, { reason: 'date_in_future' })
}

async function currencyOf(db: InventoryReader, locationId: string) {
	const row = await db
		.select({ currency: invMovements.currency })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, locationId),
				sql`${invMovements.currency} is not null`,
			),
		)
		.limit(1)
		.get()
	return row?.currency ?? undefined
}

/** `GET /stock/on-date`: what was on hand, and worth, at the end of a business day. */
export async function getStockOnDate(
	db: InventoryReader,
	input: {
		locationId: string
		date?: string
		q?: string
		includeZero?: boolean
		caller: InventoryCaller
		now: number
	},
): Promise<StockOnDate> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const clock = await clockFor(db, input.locationId, input.now)
	const date = input.date ?? clock.today
	assertDate(date, clock.today)
	const cost = input.caller.cost
	const history = cost
		? await loadCostHistory(
				db,
				await unvaluedItemIds(db, input.locationId, date),
			)
		: new Map<string, CostEvent[]>()
	const sums = await sumMovements(db, {
		locationId: input.locationId,
		date,
		inclusive: true,
		clock,
		history,
	})
	const ids = [...sums.qty.keys()]
	const refs = await loadItemRefs(db, input.locationId, ids)
	const needle = input.q?.toLowerCase()
	const items: StockOnDateItem[] = []
	let total = 0
	let unpriced = 0
	for (const id of ids) {
		const ref = refs.items.get(id)
		if (!ref) continue
		const onHand = sums.qty.get(id) ?? 0
		const value = sums.money.get(id) ?? 0
		if (!input.includeZero && onHand === 0 && value === 0) continue
		if (needle && !ref.name.toLowerCase().includes(needle)) continue
		const countUnit = refs.countUnits.get(id)
		const row: StockOnDateItem = {
			itemId: id,
			name: ref.name,
			category: ref.category,
			baseUnit: ref.baseUnit,
			countUnit: countUnit ? wireUnit(countUnit) : null,
			onHand,
		}
		if (cost) {
			const itemUnpriced = sums.unpriced.has(id) && onHand !== 0
			row.valueMinor = itemUnpriced && value === 0 ? null : value
			total += value
			if (itemUnpriced) unpriced += 1
		}
		items.push(row)
	}
	items.sort(
		(a, b) => a.name.localeCompare(b.name) || (a.itemId < b.itemId ? -1 : 1),
	)
	const result: StockOnDate = {
		locationId: input.locationId,
		date,
		today: clock.today,
		open: date === clock.today,
		items,
	}
	if (cost) {
		result.totalValueMinor = total
		result.unpricedItems = unpriced
		const currency = await currencyOf(db, input.locationId)
		if (currency) result.currency = currency
	}
	return result
}

/**
 * `GET /stock/day`: every item's opening, movements by kind and closing on one
 * business day. Opening plus the movements is closing, in quantity and in
 * money, by construction.
 */
export async function getStockDay(
	db: InventoryReader,
	input: {
		locationId: string
		date: string
		itemId?: string
		caller: InventoryCaller
		now: number
	},
): Promise<StockDay> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const clock = await clockFor(db, input.locationId, input.now)
	assertDate(input.date, clock.today)
	const cost = input.caller.cost
	const history = cost
		? await loadCostHistory(
				db,
				await unvaluedItemIds(db, input.locationId, input.date, input.itemId),
			)
		: new Map<string, CostEvent[]>()
	const opening = await sumMovements(db, {
		locationId: input.locationId,
		date: input.date,
		inclusive: false,
		clock,
		history,
		itemId: input.itemId,
	})
	const dayScope = and(
		eq(invMovements.locationId, input.locationId),
		eq(invMovements.businessDate, input.date),
		input.itemId ? eq(invMovements.itemId, input.itemId) : undefined,
	)
	const byKind = await db
		.select({
			itemId: invMovements.itemId,
			kind: invMovements.kind,
			qty: sql<number>`sum(${invMovements.quantity})`,
			valued: sql<number>`sum(case when ${invMovements.valueMinor} is null then 0 else ${invMovements.valueMinor} end)`,
			unvaluedQty: sql<number>`sum(case when ${invMovements.valueMinor} is null then ${invMovements.quantity} else 0 end)`,
		})
		.from(invMovements)
		.where(dayScope)
		.groupBy(invMovements.itemId, invMovements.kind)

	const quantities = new Map<string, Record<StockDayColumn, number>>()
	const moneys = new Map<string, Record<StockDayColumn, number>>()
	const unpriced = new Set<string>()
	const rowOf = (map: typeof quantities, itemId: string) => {
		let row = map.get(itemId)
		if (!row) {
			row = zeroColumns()
			map.set(itemId, row)
		}
		return row
	}
	for (const [itemId, qty] of opening.qty) {
		rowOf(quantities, itemId).opening = qty
		rowOf(moneys, itemId).opening = opening.money.get(itemId) ?? 0
		if (opening.unpriced.has(itemId)) unpriced.add(itemId)
	}
	for (const row of byKind) {
		const column = columnOf(row.kind)
		const q = rowOf(quantities, row.itemId)
		const m = rowOf(moneys, row.itemId)
		q[column] += Number(row.qty ?? 0)
		let value = Number(row.valued ?? 0)
		const unvaluedQty = Number(row.unvaluedQty ?? 0)
		if (unvaluedQty !== 0) {
			const average = averageAt(
				history.get(row.itemId),
				clock.endOfDay(input.date),
			)
			if (average === null) unpriced.add(row.itemId)
			else value += inventoryValueMinorClamped(unvaluedQty, average)
		}
		m[column] += value
	}
	for (const map of [quantities, moneys]) {
		for (const row of map.values()) {
			row.closing = STOCK_DAY_COLUMNS.filter(
				(c) => c !== 'closing',
			).reduce((sum, c) => sum + row[c], 0)
		}
	}
	const ids = [...quantities.keys()]
	const refs = await loadItemRefs(db, input.locationId, ids)
	const rows: StockDayRow[] = []
	const totals = zeroColumns()
	for (const id of ids) {
		const ref = refs.items.get(id)
		const q = quantities.get(id)!
		const active = STOCK_DAY_COLUMNS.some((c) => q[c] !== 0)
		if (!ref || !active) continue
		const countUnit = refs.countUnits.get(id)
		const row: StockDayRow = {
			itemId: id,
			name: ref.name,
			category: ref.category,
			baseUnit: ref.baseUnit,
			countUnit: countUnit ? wireUnit(countUnit) : null,
			quantity: q,
		}
		if (cost) {
			const m = moneys.get(id)!
			row.money = m
			for (const c of STOCK_DAY_COLUMNS) totals[c] += m[c]
		}
		rows.push(row)
	}
	rows.sort(
		(a, b) => a.name.localeCompare(b.name) || (a.itemId < b.itemId ? -1 : 1),
	)
	const result: StockDay = {
		locationId: input.locationId,
		date: input.date,
		today: clock.today,
		open: input.date === clock.today,
		rows,
	}
	if (cost) {
		result.totalsMoney = totals
		result.unpricedItems = unpriced.size
		const currency = await currencyOf(db, input.locationId)
		if (currency) result.currency = currency
	}
	return result
}

const formatMoney = (minor: number): string => (minor / 100).toFixed(2)
const formatQuantity = (thousandths: number): string =>
	(thousandths / 1000).toFixed(3).replace(/\.?0+$/, '')

/**
 * One page of the month-end stock value file (`GET /stock/value-export`),
 * built from the same `getStockOnDate` the date picker uses, so the file's
 * total is the screen's total. Needs the cost grant (the route checks). The
 * browser reads it page by page through the shared `runChunkedCsvExport`.
 */
export async function getStockValueExportChunk(
	db: InventoryReader,
	input: {
		locationId: string
		date: string
		cursor?: string
		caller: InventoryCaller
		now: number
		pageSize: number
	},
) {
	const stock = await getStockOnDate(db, {
		locationId: input.locationId,
		date: input.date,
		caller: input.caller,
		now: input.now,
	})
	const offset = input.cursor ? Number(input.cursor) : 0
	const slice = stock.items.slice(offset, offset + input.pageSize)
	const next = offset + slice.length
	const last = next >= stock.items.length
	const currency = stock.currency ?? ''
	return {
		header:
			offset === 0
				? [
						'Item',
						'Category',
						'Base unit',
						'On hand (base units)',
						`Value${currency ? ` (${currency})` : ''}`,
					]
				: undefined,
		rows: slice.map((item) => [
			item.name,
			item.category,
			item.baseUnit,
			formatQuantity(item.onHand),
			item.valueMinor === null || item.valueMinor === undefined
				? ''
				: formatMoney(item.valueMinor),
		]),
		nextCursor: last ? null : String(next),
		total: stock.items.length,
		matching: stock.items.length,
		truncated: false,
		footer: last
			? [
					[
						`Total on ${stock.date}`,
						'',
						'',
						'',
						formatMoney(stock.totalValueMinor ?? 0),
					],
				]
			: null,
	}
}
