import {
	VARIANCE_TREND_PERIODS,
	type Variance,
	type VarianceMovements,
	type VarianceRow,
} from '@repo/inventory'
import { addDays } from '@repo/reservations'
import {
	invCounts,
	invMovements,
	invRecipeLines,
	invRecipes,
} from '@repo/tenant-db'
import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import {
	assertLocationAllowed,
	locationBusinessDate,
	wireUnit,
} from './inventory-common.ts'
import { countInstants, inventoryCurrency } from './inventory-food-cost.ts'
import {
	type InventoryCaller,
	loadLocationStock,
	toItemUnit,
} from './inventory-items-service.ts'
import { readItemSales } from './item-sales.ts'

/**
 * Expected versus actual use by item between approved full counts (#509). It
 * reads the existing ledger (`inv_movements`) and the same count instants food
 * cost uses; nothing here is stored.
 *
 * For one item over a period (opening instant, closing instant]:
 *
 *   actual use   = opening + purchases - closing        (purchases: deliveries
 *                  and transfers in, less transfers out)
 *   expected use = -(sales + batches used + batches made)  (what recipes say)
 *   gap          = actual - expected
 *                = -(waste + adjustments + what the closing count found)
 *
 * and in money the same identities over every item, so the totals are exactly
 * the period's actual food cost (`computeFoodCost`'s opening + purchases -
 * closing) minus its expected food cost. The ledger holds a correction of a
 * waste entry as a `waste` movement (or none when an approved count already
 * covers it), so waste here is "as corrected".
 */

type Sums = { quantity: number; value: number }
const zero = (): Sums => ({ quantity: 0, value: 0 })

type ItemFigures = {
	opening: Sums
	byKind: Map<string, Sums>
}

type PeriodFigures = {
	openingAt: number
	closingAt: number
	openingCountId: string
	closingCountId: string
	items: Map<string, ItemFigures>
}

const kind = (figures: ItemFigures, name: string): Sums =>
	figures.byKind.get(name) ?? zero()

type CountPoint = { id: string; at: number }

/** The approved full counts of a location, oldest first, by the instant each measured the shelves. */
async function fullCounts(
	db: InventoryReader,
	locationId: string,
): Promise<CountPoint[]> {
	const rows = await db
		.select({ id: invCounts.id, approvedAt: invCounts.approvedAt })
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, locationId),
				eq(invCounts.status, 'approved'),
				isNull(invCounts.listId),
				// A quick count only corrects what it counted: periods use full counts.
				eq(invCounts.kind, 'full'),
			),
		)
		.orderBy(desc(invCounts.approvedAt), desc(invCounts.id))
		.limit(VARIANCE_TREND_PERIODS + 1)
	const instants = await countInstants(
		db,
		rows.map((row) => row.id),
	)
	return rows
		.filter((row) => row.approvedAt !== null)
		.map((row) => ({
			id: row.id,
			at: instants.get(row.id) ?? row.approvedAt!,
		}))
		.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

async function loadPeriod(
	db: InventoryReader,
	locationId: string,
	opening: CountPoint,
	closing: CountPoint,
): Promise<PeriodFigures> {
	const [openingRows, windowRows] = await Promise.all([
		db
			.select({
				itemId: invMovements.itemId,
				quantity: sql<number>`coalesce(sum(${invMovements.quantity}), 0)`,
				value: sql<number>`coalesce(sum(${invMovements.valueMinor}), 0)`,
			})
			.from(invMovements)
			.where(
				and(
					eq(invMovements.locationId, locationId),
					lte(invMovements.createdAt, opening.at),
				),
			)
			.groupBy(invMovements.itemId),
		db
			.select({
				itemId: invMovements.itemId,
				kind: invMovements.kind,
				quantity: sql<number>`coalesce(sum(${invMovements.quantity}), 0)`,
				value: sql<number>`coalesce(sum(${invMovements.valueMinor}), 0)`,
			})
			.from(invMovements)
			.where(
				and(
					eq(invMovements.locationId, locationId),
					gt(invMovements.createdAt, opening.at),
					lte(invMovements.createdAt, closing.at),
				),
			)
			.groupBy(invMovements.itemId, invMovements.kind),
	])
	const items = new Map<string, ItemFigures>()
	const figures = (itemId: string): ItemFigures => {
		let found = items.get(itemId)
		if (!found) {
			found = { opening: zero(), byKind: new Map() }
			items.set(itemId, found)
		}
		return found
	}
	for (const row of openingRows) {
		figures(row.itemId).opening = {
			quantity: Number(row.quantity),
			value: Number(row.value),
		}
	}
	for (const row of windowRows) {
		figures(row.itemId).byKind.set(row.kind, {
			quantity: Number(row.quantity),
			value: Number(row.value),
		})
	}
	return {
		openingAt: opening.at,
		closingAt: closing.at,
		openingCountId: opening.id,
		closingCountId: closing.id,
		items,
	}
}

type ItemResult = {
	opening: number
	delivered: number
	transfers: number
	batchMade: number
	waste: number
	closing: number
	actualUse: number
	expectedUse: number
	actualMinor: number
	expectedMinor: number
	wasteMinor: number
}

/** The figures of one item over one period (see the file comment for the identities). */
function figuresOf(item: ItemFigures): ItemResult {
	const delivery = kind(item, 'delivery')
	const transferIn = kind(item, 'transfer_in')
	const transferOut = kind(item, 'transfer_out')
	const made = kind(item, 'batch_made')
	const used = kind(item, 'batch_used')
	const sale = kind(item, 'sale')
	const waste = kind(item, 'waste')
	let changeQuantity = 0
	let changeValue = 0
	for (const sums of item.byKind.values()) {
		changeQuantity += sums.quantity
		changeValue += sums.value
	}
	const closingQuantity = item.opening.quantity + changeQuantity
	const purchasesQuantity =
		delivery.quantity + transferIn.quantity + transferOut.quantity
	const purchasesValue = delivery.value + transferIn.value + transferOut.value
	const closingValue = item.opening.value + changeValue
	return {
		opening: item.opening.quantity,
		delivered: delivery.quantity,
		transfers: transferIn.quantity + transferOut.quantity,
		batchMade: made.quantity,
		waste: -waste.quantity,
		closing: closingQuantity,
		actualUse: item.opening.quantity + purchasesQuantity - closingQuantity,
		expectedUse: -(sale.quantity + used.quantity + made.quantity),
		actualMinor: item.opening.value + purchasesValue - closingValue,
		expectedMinor: -(sale.value + used.value + made.value),
		wasteMinor: -waste.value,
	}
}

/** Items some recipe uses (as an ingredient, or a made item with its own recipe). */
async function recipeItemIds(db: InventoryReader): Promise<Set<string>> {
	const [lines, made] = await Promise.all([
		db.selectDistinct({ itemId: invRecipeLines.itemId }).from(invRecipeLines),
		db
			.selectDistinct({ ownerId: invRecipes.ownerId })
			.from(invRecipes)
			.where(eq(invRecipes.ownerKind, 'made_item')),
	])
	return new Set([
		...lines.map((row) => row.itemId),
		...made.map((row) => row.ownerId),
	])
}

const shortDate = (db: InventoryReader, locationId: string, at: number) =>
	locationBusinessDate(db, locationId, at)

export async function getVariance(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		closingCountId?: string
	},
): Promise<Variance> {
	const { caller, locationId } = input
	assertLocationAllowed(caller.locationIds, locationId)
	const counts = await fullCounts(db, locationId)
	if (counts.length < 2) {
		return { state: 'need_two_counts', period: null, periods: [], rows: [] }
	}
	// Consecutive counts make periods; newest first.
	const pairs = counts
		.slice(1)
		.map((closing, index) => ({ opening: counts[index]!, closing }))
		.reverse()
	const chosen = input.closingCountId
		? pairs.find((pair) => pair.closing.id === input.closingCountId)
		: pairs[0]
	if (!chosen) throw new InventoryError('not_found', 404)
	const trendPairs = pairs
		.slice(
			pairs.indexOf(chosen),
			pairs.indexOf(chosen) + VARIANCE_TREND_PERIODS,
		)
		.reverse()

	const [periods, noRecipeSet, stock] = await Promise.all([
		Promise.all(
			trendPairs.map((pair) =>
				loadPeriod(db, locationId, pair.opening, pair.closing),
			),
		),
		recipeItemIds(db),
		loadLocationStock(db, locationId, { includeArchived: true }),
	])
	const stockById = new Map(stock.map((row) => [row.item.id, row]))
	const current = periods[periods.length - 1]!

	const [openingDate, closingDate, currency] = await Promise.all([
		shortDate(db, locationId, chosen.opening.at),
		shortDate(db, locationId, chosen.closing.at),
		inventoryCurrency(db, locationId),
	])
	const withMoney = caller.cost
	let salesMinor: number | undefined
	if (withMoney) {
		const sales = await readItemSales(db, {
			locationId,
			fromDate: addDays(openingDate, 1),
			toDate: closingDate,
		})
		const wanted = currency ?? sales.items[0]?.currency ?? null
		salesMinor = sales.items
			.filter((row) => row.currency === wanted)
			.reduce((sum, row) => sum + row.netSalesMinor, 0)
	}
	const bpOfSales = (minor: number): number | null =>
		salesMinor && salesMinor > 0
			? Math.round((minor * 10_000) / salesMinor)
			: null

	// Per period, per item.
	const perPeriod = periods.map((period) => {
		const map = new Map<string, ItemResult>()
		for (const [itemId, item] of period.items) map.set(itemId, figuresOf(item))
		return map
	})
	const results = perPeriod[perPeriod.length - 1]!

	const rows: VarianceRow[] = []
	let actualMinor = 0
	let expectedMinor = 0
	let noRecipeUseMinor = 0
	let wasteMinor = 0
	for (const [itemId, figures] of results) {
		actualMinor += figures.actualMinor
		expectedMinor += figures.expectedMinor
		wasteMinor += figures.wasteMinor
		const noRecipe = !noRecipeSet.has(itemId)
		if (noRecipe) noRecipeUseMinor += figures.actualMinor
		const entry = stockById.get(itemId)
		const quiet =
			figures.opening === 0 &&
			figures.closing === 0 &&
			figures.actualUse === 0 &&
			figures.expectedUse === 0 &&
			figures.waste === 0
		if (!entry || quiet) continue
		const gap = (result: ItemResult | undefined) =>
			result === undefined || noRecipe
				? null
				: result.actualUse - result.expectedUse
		const gapMoney = (result: ItemResult | undefined) =>
			result === undefined || noRecipe
				? undefined
				: result.actualMinor - result.expectedMinor
		const row: VarianceRow = {
			itemId,
			name: entry.item.name,
			baseUnit: entry.item.baseUnit,
			countUnit: entry.place?.countUnit
				? wireUnit(entry.place.countUnit)
				: wireUnit('piece'),
			units: entry.units
				.filter((unit) => unit.archivedAt === null)
				.map(toItemUnit),
			opening: figures.opening,
			delivered: figures.delivered,
			transfers: figures.transfers,
			batchMade: figures.batchMade,
			waste: figures.waste,
			closing: figures.closing,
			actualUse: figures.actualUse,
			expectedUse: noRecipe ? null : figures.expectedUse,
			gapQuantity: gap(figures),
			noRecipe,
			trend: periods.map((period, index) => {
				const result = perPeriod[index]!.get(itemId)
				const point: VarianceRow['trend'][number] = {
					closingCountId: period.closingCountId,
					to: '',
					gapQuantity: gap(result),
				}
				const money = withMoney ? gapMoney(result) : undefined
				if (money !== undefined) point.gapMinor = money
				return point
			}),
		}
		if (withMoney) {
			row.actualUseMinor = figures.actualMinor
			if (!noRecipe) {
				row.expectedUseMinor = figures.expectedMinor
				row.gapMinor = figures.actualMinor - figures.expectedMinor
				row.gapBpOfSales = bpOfSales(row.gapMinor)
			}
		}
		rows.push(row)
	}
	// Business dates of each period's closing instant, for the trend labels.
	const closingDates = await Promise.all(
		periods.map((period) => shortDate(db, locationId, period.closingAt)),
	)
	for (const row of rows) {
		row.trend.forEach((point, index) => {
			point.to = closingDates[index]!
		})
	}
	rows.sort((a, b) => {
		// Items without a recipe have no gap: they follow, biggest use first.
		if (a.noRecipe !== b.noRecipe) return a.noRecipe ? 1 : -1
		if (withMoney) {
			return (
				(b.gapMinor ?? b.actualUseMinor ?? 0) -
					(a.gapMinor ?? a.actualUseMinor ?? 0) ||
				a.name.toLowerCase().localeCompare(b.name.toLowerCase())
			)
		}
		return (
			(b.gapQuantity ?? b.actualUse) - (a.gapQuantity ?? a.actualUse) ||
			a.name.toLowerCase().localeCompare(b.name.toLowerCase())
		)
	})

	const result: Variance = {
		state: 'ok',
		period: {
			openingCountId: current.openingCountId,
			closingCountId: current.closingCountId,
			from: openingDate,
			to: closingDate,
			openingAt: current.openingAt,
			closingAt: current.closingAt,
		},
		periods: await Promise.all(
			pairs.map(async (pair) => ({
				closingCountId: pair.closing.id,
				from: await shortDate(db, locationId, pair.opening.at),
				to: await shortDate(db, locationId, pair.closing.at),
			})),
		),
		rows,
	}
	if (withMoney) {
		const gapMinor = actualMinor - expectedMinor
		result.salesMinor = salesMinor ?? 0
		result.totals = {
			actualMinor,
			expectedMinor,
			gapMinor,
			gapBpOfSales: bpOfSales(gapMinor),
			noRecipeUseMinor,
			wasteMinor,
		}
		if (currency) result.currency = currency
	}
	return result
}

const MOVEMENT_PAGE = 200

/** The movements behind one row of the report: what moved the item between the two counts. */
export async function getVarianceMovements(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		closingCountId?: string
		itemId: string
	},
): Promise<VarianceMovements> {
	const { caller, locationId } = input
	assertLocationAllowed(caller.locationIds, locationId)
	const counts = await fullCounts(db, locationId)
	const pairs = counts
		.slice(1)
		.map((closing, index) => ({ opening: counts[index]!, closing }))
		.reverse()
	const chosen = input.closingCountId
		? pairs.find((pair) => pair.closing.id === input.closingCountId)
		: pairs[0]
	if (!chosen) {
		// No period yet (fewer than two approved full counts): nothing moved between them.
		if (input.closingCountId) throw new InventoryError('not_found', 404)
		return { itemId: input.itemId, movements: [], truncated: false }
	}
	const rows = await db
		.select()
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, locationId),
				eq(invMovements.itemId, input.itemId),
				gt(invMovements.createdAt, chosen.opening.at),
				lte(invMovements.createdAt, chosen.closing.at),
			),
		)
		.orderBy(desc(invMovements.createdAt), desc(invMovements.id))
		.limit(MOVEMENT_PAGE + 1)
	const page = rows.slice(0, MOVEMENT_PAGE)
	return {
		itemId: input.itemId,
		movements: page.map((row) => ({
			id: row.id,
			kind: row.kind,
			quantity: row.quantity,
			...(caller.cost && row.valueMinor !== null
				? {
						valueMinor: row.valueMinor,
						...(row.currency ? { currency: row.currency } : {}),
					}
				: {}),
			reason: row.reason,
			sourceType: row.sourceType,
			businessDate: row.businessDate,
			createdAt: row.createdAt,
		})),
		truncated: rows.length > MOVEMENT_PAGE,
	}
}
