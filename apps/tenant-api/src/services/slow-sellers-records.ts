import {
	intersectIntervalSets,
	mergeIntervals,
	rankSlowSellers,
	type MenuRoster,
	type SlowSellerSales,
} from '@repo/common/slow-sellers'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { MAX_RECIPE_COST_REFS } from '@repo/inventory'
import {
	type FilterCondition,
	type ReportDefinition,
	type ReportRecord,
	resolveTimeframeRange,
} from '@repo/reports'
import { type TenantDatabase } from '@repo/tenant-db'
import { getInventoryFlagState } from '../lib/inventory-context.ts'
import { getMenuRoster } from '../lib/menu-roster.ts'
import { getNodeRegion } from '../lib/region.ts'
import { readSaleLines } from './item-sales.ts'
import { recipeCosts } from './inventory-recipes-service.ts'
import { loadSoldOutOccurrences } from './sold-out-report-records.ts'

/**
 * Records for the Slow sellers report (#261): one per menu dish (and currency
 * it sold in), joined from the menu (control plane, by id) and the sales (the
 * one items-sold walk), with sold-out history from the region.
 *
 * Location and channel narrow which sales a dish is ranked on, so they are
 * read here from the definition's filters (`splitLoaderFilters` takes them
 * out of the engine's way). The category filter is the engine's own.
 */

/** Longest period one run ranks over (a year-long ranking is already coarse). */
export const SLOW_SELLERS_MAX_DAYS = 400

const DAY_MS = 86_400_000

export class MenuRosterUnavailableError extends Error {
	constructor() {
		super('menu_unavailable')
		this.name = 'MenuRosterUnavailableError'
	}
}

export type SlowSellersContext = {
	db: TenantDatabase
	orgId: string
	/** The token's locations; null for every one. */
	locationIds: readonly string[] | null
	now: Date
	/** The token holds the inventory cost permission. */
	costAllowed: boolean
	/** Who is asking (an opaque member id), for the cost call's audit. */
	userId: string
}

function allows(value: string, condition: FilterCondition): boolean {
	const raw = condition.value
	const text = typeof raw === 'string' ? raw : ''
	switch (condition.operator) {
		case 'eq':
			return value === text
		case 'neq':
			return value !== text
		case 'in':
			return Array.isArray(raw) ? raw.includes(value) : value === text
		case 'contains':
			return value.toLowerCase().includes(text.toLowerCase())
		case 'starts_with':
			return value.toLowerCase().startsWith(text.toLowerCase())
		case 'is_empty':
			return value === ''
		case 'is_not_empty':
			return value !== ''
	}
}

function scopeLocations(
	roster: MenuRoster,
	ctx: SlowSellersContext,
	conditions: readonly FilterCondition[],
): string[] {
	let ids = roster.locations
		.filter((location) => {
			for (const condition of conditions) {
				if (condition.field === 'locationId' && !allows(location.id, condition))
					return false
				if (
					condition.field === 'location' &&
					!allows(getLocalizedMenuValue(location.name), condition) &&
					!allows(location.name, condition)
				)
					return false
			}
			return true
		})
		.map((location) => location.id)
	if (ctx.locationIds !== null) {
		const allowed = new Set(ctx.locationIds)
		ids = ids.filter((id) => allowed.has(id))
	}
	return ids
}

function currencyDefault(): string {
	return getNodeRegion() === 'ksa' ? 'SAR' : 'USD'
}

async function foodCostByDish(
	ctx: SlowSellersContext,
	roster: MenuRoster,
	currency: string,
): Promise<Map<string, number>> {
	const out = new Map<string, number>()
	if (!ctx.costAllowed) return out
	const flags = await getInventoryFlagState(ctx.orgId)
	if (flags.status !== 'on' || !flags.features.recipes) return out
	const refs = roster.dishes
		.filter((dish) => dish.price > 0)
		.map((dish) => ({
			key: dish.id,
			itemId: dish.id,
			priceMinor: Math.round(dish.price * 100),
		}))
	for (let index = 0; index < refs.length; index += MAX_RECIPE_COST_REFS) {
		const { rows } = await recipeCosts(
			ctx.db,
			{
				orgId: ctx.orgId,
				region: getNodeRegion(),
				actor: { kind: 'operator', id: ctx.userId },
				cost: true,
			},
			{ refs: refs.slice(index, index + MAX_RECIPE_COST_REFS), currency },
		)
		for (const row of rows) {
			if (row.foodCostBp !== undefined) out.set(row.key, row.foodCostBp / 100)
		}
	}
	return out
}

export async function loadSlowSellerRecords(
	ctx: SlowSellersContext,
	definition: ReportDefinition,
	loaderFilters: readonly FilterCondition[],
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const roster = await getMenuRoster(ctx.orgId)
	if (!roster) throw new MenuRosterUnavailableError()

	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	const toMs = Math.min(range.end.getTime(), ctx.now.getTime())
	const fromMs = Math.max(
		range.start ? range.start.getTime() : toMs - SLOW_SELLERS_MAX_DAYS * DAY_MS,
		toMs - SLOW_SELLERS_MAX_DAYS * DAY_MS,
	)
	if (toMs <= fromMs) return { records: [], truncated: false }

	const channelConditions = loaderFilters.filter(
		(condition) => condition.field === 'channel',
	)
	const locationIds = scopeLocations(roster, ctx, loaderFilters)
	const oneLocation =
		loaderFilters.some(
			(condition) =>
				(condition.field === 'location' || condition.field === 'locationId') &&
				condition.operator === 'eq',
		) && locationIds.length === 1
			? locationIds[0]!
			: null

	// Sales: the one items-sold walk, narrowed to the asked locations and channels.
	const { sales, truncated } =
		locationIds.length === 0
			? { sales: [], truncated: false }
			: await readSaleLines(ctx.db, {
					fromDate: new Date(fromMs - DAY_MS).toISOString().slice(0, 10),
					toDate: new Date(toMs + DAY_MS).toISOString().slice(0, 10),
					locationIds,
				})
	type Bucket = {
		sold: Map<string, SlowSellerSales>
		orders: number
	}
	const byCurrency = new Map<string, Bucket>()
	for (const sale of sales) {
		if (sale.occurredAtMs < fromMs || sale.occurredAtMs > toMs) continue
		if (channelConditions.some((condition) => !allows(sale.channel, condition)))
			continue
		const bucket = byCurrency.get(sale.currency) ?? {
			sold: new Map<string, SlowSellerSales>(),
			orders: 0,
		}
		bucket.orders += 1
		const seen = new Set<string>()
		for (const line of sale.lines) {
			const row = bucket.sold.get(line.itemId) ?? {
				itemId: line.itemId,
				quantity: 0,
				salesMinor: 0,
				orders: 0,
				lastSoldMs: 0,
			}
			row.quantity += line.quantity
			row.salesMinor += line.netMinor
			if (!seen.has(line.itemId)) {
				row.orders += 1
				seen.add(line.itemId)
			}
			row.lastSoldMs = Math.max(row.lastSoldMs, sale.occurredAtMs)
			bucket.sold.set(line.itemId, row)
		}
		byCurrency.set(sale.currency, bucket)
	}

	// Sold-out time per dish: a dish counts as off only while it is off at every
	// location in scope (one location: that one).
	const occurrences = await loadSoldOutOccurrences(
		{
			db: ctx.db,
			orgId: ctx.orgId,
			locationIds: locationIds.length > 0 ? locationIds : [],
			now: ctx.now,
		},
		{ startMs: fromMs, endMs: toMs },
		{ overlapping: true },
	)
	const perDishPerLocation = new Map<string, Map<string, Array<[number, number]>>>()
	for (const occurrence of occurrences) {
		if (occurrence.entityType !== 'item') continue
		const list = perDishPerLocation.get(occurrence.entityId) ?? new Map()
		const spans = list.get(occurrence.locationId) ?? []
		spans.push([
			occurrence.startedAt.getTime(),
			occurrence.endedAt?.getTime() ?? toMs,
		])
		list.set(occurrence.locationId, spans)
		perDishPerLocation.set(occurrence.entityId, list)
	}
	const unavailable = new Map<string, Array<{ startMs: number; endMs: number | null }>>()
	for (const [dishId, byLocation] of perDishPerLocation) {
		const sets = locationIds.map((id) =>
			mergeIntervals(
				(byLocation.get(id) ?? []).map(([startMs, endMs]) => ({ startMs, endMs })),
				fromMs,
				toMs,
			),
		)
		const common = intersectIntervalSets(sets)
		if (common.length > 0) {
			unavailable.set(
				dishId,
				common.map(([startMs, endMs]) => ({ startMs, endMs })),
			)
		}
	}

	// Unsold dishes appear in the currency with the most orders; a dish also
	// appears in another currency only where it sold.
	const currencies = [...byCurrency.entries()]
		.sort((a, b) => b[1].orders - a[1].orders || a[0].localeCompare(b[0]))
		.map(([currency]) => currency)
	const primary = currencies[0] ?? currencyDefault()
	if (currencies.length === 0) currencies.push(primary)

	const records: ReportRecord[] = []
	const periodEnd = new Date(toMs)
	for (const currency of currencies) {
		const bucket = byCurrency.get(currency)
		const dishes =
			currency === primary
				? roster.dishes
				: roster.dishes.filter((dish) => bucket?.sold.has(dish.id))
		const costs = await foodCostByDish(ctx, roster, currency)
		const rows = rankSlowSellers({
			dishes,
			sales: bucket?.sold ?? new Map(),
			totalOrders: bucket?.orders ?? 0,
			window: { fromMs, toMs },
			unavailable,
			currency,
			foodCostPercent: costs,
			locationId: oneLocation,
			now: ctx.now.getTime(),
		})
		for (const row of rows) {
			records.push({
				periodEnd,
				item: getLocalizedMenuValue(row.name) || row.itemId,
				itemId: row.itemId,
				category: getLocalizedMenuValue(row.categoryName),
				categoryId: row.categoryId,
				// Placeholders: the loader already applied these (see splitLoaderFilters).
				location: '',
				locationId: '',
				channel: '',
				currency: row.currency,
				quantity: row.quantity,
				sales: row.salesMinor / 100,
				shareOfOrders: row.shareOfOrders,
				daysSinceLastSold: row.daysSinceLastSold,
				availableWholePeriod: row.availableWholePeriod,
				status: row.status,
				sortKey: row.sortKey,
				...(row.foodCostPercent !== null
					? { foodCostPercent: row.foodCostPercent }
					: {}),
			})
		}
	}
	return { records, truncated }
}
