import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	EARLIER_SALES,
	type ProductMixRow,
} from '@repo/reports/product-mix'
import {
	type ReportDefinition,
	type ReportRecord,
	resolveTimeframeRange,
} from '@repo/reports'
import { type TenantDatabase } from '@repo/tenant-db'
import { readSaleLines, type SaleWithLines } from './item-sales.ts'

/**
 * Product mix (#227): one row per sale line and per chosen option, with the
 * menu and category the dish was sold under at the time of sale. It is a
 * visitor of the one items-sold walk (`readSaleLines` in `item-sales.ts`): the
 * same channels, the same "counts toward sales" rule and the same net as the
 * Items sold report and the food cost figures, so the totals agree.
 *
 * A line with no stamped category (sold before it was recorded, or a Station
 * sale whose menu could not be reached) reads "Earlier sales". Money is kept
 * per currency and never added across them. No guest data is read or kept.
 */

/** Most records one run builds; a run past it says its sources were cut. */
export const PRODUCT_MIX_MAX_RECORDS = 200_000

const DAY_MS = 86_400_000

function ymd(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10)
}

export type ProductMixWindow = { fromMs: number | null; toMs: number }

export type ProductMixLoadContext = {
	db: TenantDatabase
	locationIds: readonly string[] | null
	now: Date
}

function windowFor(
	definition: Pick<ReportDefinition, 'timeframe'>,
	now: Date,
): ProductMixWindow {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	return {
		fromMs: range.start ? range.start.getTime() : null,
		toMs: range.end.getTime(),
	}
}

async function readWindow(
	ctx: ProductMixLoadContext,
	window: ProductMixWindow,
): Promise<{ sales: SaleWithLines[]; truncated: boolean }> {
	if (ctx.locationIds !== null && ctx.locationIds.length === 0) {
		return { sales: [], truncated: false }
	}
	// Business dates differ from instants by a day at most each way, so the
	// window is read a day wider and each record is cut exactly by its time.
	const fromDate = window.fromMs === null ? '2000-01-01' : ymd(window.fromMs - DAY_MS)
	const toDate = ymd(window.toMs + DAY_MS)
	return readSaleLines(ctx.db, {
		fromDate,
		toDate,
		locationIds: ctx.locationIds,
	})
}

function placementOf(line: SaleWithLines['lines'][number]) {
	const placement = line.placement
	return {
		menuId: placement?.menuId ?? '',
		menu: placement ? getLocalizedMenuValue(placement.menuName) || EARLIER_SALES : EARLIER_SALES,
		categoryId: placement?.categoryId ?? '',
		category: placement
			? getLocalizedMenuValue(placement.categoryName) || EARLIER_SALES
			: EARLIER_SALES,
	}
}

/** Finest-grain rows for the tree and the exports: dish rows and option rows. */
export function productMixRowsFrom(
	sales: readonly SaleWithLines[],
	window: ProductMixWindow,
	filter?: { channels?: readonly string[] | null },
): ProductMixRow[] {
	const dish = new Map<string, ProductMixRow>()
	const options = new Map<string, ProductMixRow>()
	for (const sale of sales) {
		if (window.fromMs !== null && sale.occurredAtMs < window.fromMs) continue
		if (sale.occurredAtMs > window.toMs) continue
		if (filter?.channels && !filter.channels.includes(sale.channel)) continue
		for (const line of sale.lines) {
			const place = placementOf(line)
			const base = {
				currency: sale.currency,
				menuId: place.menuId,
				menu: place.menu,
				categoryId: place.categoryId,
				category: place.category,
				itemId: line.itemId,
				item: line.itemName || line.itemId,
			}
			const dishKey = JSON.stringify([
				sale.currency,
				place.menuId,
				place.menu,
				place.categoryId,
				place.category,
				line.itemId,
			])
			const row = dish.get(dishKey) ?? {
				kind: 'dish' as const,
				...base,
				quantity: 0,
				salesMinor: 0,
			}
			row.quantity += line.quantity
			row.salesMinor += line.netMinor
			dish.set(dishKey, row)
			for (const option of line.options) {
				const optionKey = JSON.stringify([
					dishKey,
					option.groupId,
					option.groupName,
					option.optionId,
					option.optionName,
				])
				const optionRow = options.get(optionKey) ?? {
					kind: 'option' as const,
					...base,
					optionGroup: option.groupName,
					option: option.optionName,
					quantity: 0,
					salesMinor: 0,
				}
				optionRow.quantity += option.quantity
				optionRow.salesMinor += option.netMinor
				options.set(optionKey, optionRow)
			}
		}
	}
	return [...dish.values(), ...options.values()]
}

export async function loadProductMixRows(
	ctx: ProductMixLoadContext,
	window: ProductMixWindow,
	filter?: { channels?: readonly string[] | null },
): Promise<{ rows: ProductMixRow[]; truncated: boolean }> {
	const { sales, truncated } = await readWindow(ctx, window)
	return { rows: productMixRowsFrom(sales, window, filter), truncated }
}

/**
 * Records for the engine subjects `product_mix` (one per dish line) and
 * `product_mix_options` (one per chosen option). Sales are net minor units
 * over 100, like every other report subject.
 */
export async function loadProductMixRecords(
	ctx: ProductMixLoadContext,
	definition: ReportDefinition,
	kind: 'dish' | 'option',
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const window = windowFor(definition, ctx.now)
	const { sales, truncated: salesTruncated } = await readWindow(ctx, window)
	const records: ReportRecord[] = []
	let truncated = salesTruncated
	for (const sale of sales) {
		if (window.fromMs !== null && sale.occurredAtMs < window.fromMs) continue
		if (sale.occurredAtMs > window.toMs) continue
		for (const line of sale.lines) {
			if (records.length >= PRODUCT_MIX_MAX_RECORDS) {
				truncated = true
				break
			}
			const place = placementOf(line)
			const common = {
				occurredAt: new Date(sale.occurredAtMs),
				location: sale.locationName || sale.locationId,
				locationId: sale.locationId,
				channel: sale.channel,
				currency: sale.currency,
				...place,
				itemId: line.itemId,
				item: line.itemName || line.itemId,
			}
			if (kind === 'dish') {
				records.push({
					...common,
					quantity: line.quantity,
					sales: line.netMinor / 100,
					grossSales: line.grossMinor / 100,
				})
				continue
			}
			for (const option of line.options) {
				records.push({
					...common,
					optionGroup: option.groupName,
					option: option.optionName,
					quantity: option.quantity,
					sales: option.netMinor / 100,
				})
			}
		}
	}
	return { records, truncated }
}
