import { and, between, eq } from 'drizzle-orm'
import {
	businessDateOf,
	DEFAULT_SALES_SOURCE,
	DEFAULT_TIP_SETTINGS,
	DEMAND_BUCKET_SECONDS,
	type LaborSettingsView,
	type LaborSalesFact,
	type SalesEntryView,
	type TipFulfillment,
	type TipPoolSettingsView,
	addDays,
	businessDayStartMs,
} from '@repo/staffing'
import {
	laborScopeSettings,
	salesManualEntries,
	tipPoolSettings,
	type SalesManualEntryRow,
} from '@repo/tenant-db'
import { getDemandSource } from './demand-sources.ts'
import { getOrderSource, type OrderBucketRow } from './order-source.ts'
import { type StaffDb } from './staff-audit.ts'

/**
 * Reads the labor summary builds on: the per-scope settings, manual sales
 * entries and, where a vertical registered an order source, order buckets of 15
 * minutes (the same grain as the demand guide). The generic module has none, so
 * sales are the figures a team enters.
 * Nothing here applies grants or scope; the services above it do.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The sales source a scope starts with when a vertical registered an order source. */
const ORDER_SOURCE_SALES_SOURCE = 'online_orders' as const

/**
 * Standards by demand unit. `orders` mirrors the older `orders_per_labor_hour`
 * column, which older code still writes: it wins only while it holds something
 * the per-unit column does not.
 */
function standardsOf(
	row:
		| {
				ordersPerLaborHour: Record<string, number>
				demandPerLaborHour: Record<string, Record<string, number>>
		  }
		| undefined,
): Pick<LaborSettingsView, 'ordersPerLaborHour' | 'demandPerLaborHour'> {
	const demand = { ...row?.demandPerLaborHour }
	const legacy = row?.ordersPerLaborHour ?? {}
	const orders =
		demand.orders && Object.keys(demand.orders).length > 0
			? demand.orders
			: legacy
	if (Object.keys(orders).length > 0) demand.orders = orders
	return { ordersPerLaborHour: orders, demandPerLaborHour: demand }
}

export async function loadLaborSettings(
	db: StaffDb,
	scopeId: string,
): Promise<LaborSettingsView> {
	const [row] = await db
		.select()
		.from(laborScopeSettings)
		.where(eq(laborScopeSettings.scopeId, scopeId))
		.limit(1)
	return {
		scopeId,
		// Without an order source (the generic module has none) sales are manual.
		salesSource:
			row?.salesSource ??
			(getOrderSource() ? ORDER_SOURCE_SALES_SOURCE : DEFAULT_SALES_SOURCE),
		...standardsOf(row),
		configured: row !== undefined,
		updatedAt: row?.updatedAt ?? null,
	}
}

export async function loadTipPoolSettings(
	db: StaffDb,
	scopeId: string,
): Promise<TipPoolSettingsView> {
	const [row] = await db
		.select()
		.from(tipPoolSettings)
		.where(eq(tipPoolSettings.scopeId, scopeId))
		.limit(1)
	if (!row) {
		return {
			scopeId,
			...DEFAULT_TIP_SETTINGS,
			configured: false,
			updatedAt: null,
		}
	}
	return {
		scopeId,
		splitBasis: row.splitBasis,
		cadence: row.cadence,
		cardFeeBp: row.cardFeeBp,
		fulfillment: row.fulfillment.filter(
			(value): value is TipFulfillment =>
				value === 'pickup' || value === 'delivery',
		),
		positionPercentBp: row.positionPercentBp,
		configured: true,
		updatedAt: row.updatedAt,
	}
}

// ---------------------------------------------------------------------------
// Manual sales
// ---------------------------------------------------------------------------

export function toSalesEntryView(row: SalesManualEntryRow): SalesEntryView {
	return {
		id: row.id,
		scopeId: row.scopeId,
		date: row.businessDate,
		netSalesMinor: row.netSalesMinor,
		currency: row.currency,
		source: row.source,
		note: row.note,
		updatedAt: row.updatedAt,
	}
}

export async function loadManualSales(
	db: StaffDb,
	scopeId: string,
	from: string,
	to: string,
): Promise<SalesManualEntryRow[]> {
	return db
		.select()
		.from(salesManualEntries)
		.where(
			and(
				eq(salesManualEntries.scopeId, scopeId),
				between(salesManualEntries.businessDate, from, to),
			),
		)
		.orderBy(salesManualEntries.businessDate)
}

export function manualSalesFacts(
	rows: readonly SalesManualEntryRow[],
): LaborSalesFact[] {
	return rows.map((row) => ({
		date: row.businessDate,
		currency: row.currency.toUpperCase(),
		salesMinor: row.netSalesMinor,
	}))
}

// ---------------------------------------------------------------------------
// Online orders by business date
// ---------------------------------------------------------------------------

/** Epoch-second bounds `[from, to)` of the business days `from` to `to`. */
export function businessRangeSeconds(
	from: string,
	to: string,
	timeZone: string,
	workdayStartMinute: number,
): { fromSeconds: number; toSeconds: number } {
	return {
		fromSeconds: Math.floor(
			businessDayStartMs(from, timeZone, workdayStartMinute) / 1000,
		),
		toSeconds: Math.ceil(
			businessDayStartMs(addDays(to, 1), timeZone, workdayStartMinute) / 1000,
		),
	}
}

/**
 * Buckets are aligned to the workday start so no bucket straddles a business
 * day boundary: UTC offsets are whole quarter hours, so the start of every
 * business day sits the same number of seconds past a bucket edge.
 */
export function bucketAlignSeconds(workdayStartMinute: number): number {
	return (workdayStartMinute * 60) % DEMAND_BUCKET_SECONDS
}

/**
 * Counted orders of one scope in a window, one row per 15-minute bucket,
 * currency and fulfillment type. Empty unless a vertical registered an order
 * source (see `order-source.ts`); labor sales then come from the manual entries.
 */
export async function loadOrderBuckets(
	db: StaffDb,
	scopeId: string,
	fromSeconds: number,
	toSeconds: number,
	workdayStartMinute = 0,
): Promise<OrderBucketRow[]> {
	const source = getOrderSource()
	if (!source) return []
	return source.loadBuckets(db, scopeId, {
		fromSeconds,
		toSeconds,
		alignSeconds: bucketAlignSeconds(workdayStartMinute),
	})
}

/**
 * Counted units of another demand source (for example `visits`) in the same
 * rows the order buckets use, so one guide computation serves every unit. No
 * money rides along. Empty when no such source is registered.
 */
export async function loadSourceBuckets(
	db: StaffDb,
	sourceId: string,
	scopeId: string,
	fromSeconds: number,
	toSeconds: number,
	workdayStartMinute = 0,
): Promise<OrderBucketRow[]> {
	const source = getDemandSource(sourceId)
	if (!source) return []
	const rows = await source.loadBuckets(db, scopeId, {
		fromSeconds,
		toSeconds,
		alignSeconds: bucketAlignSeconds(workdayStartMinute),
	})
	return rows.map((row) => ({
		bucket: row.bucket,
		currency: '',
		fulfillment: 'pickup' as const,
		orders: row.units,
		subtotalMinor: 0,
		tipMinor: 0,
	}))
}

/** The business date a bucket belongs to (by the bucket's first instant, see `bucketAlignSeconds`). */
export function bucketBusinessDate(
	bucket: number,
	timeZone: string,
	workdayStartMinute: number,
): string {
	return businessDateOf(
		(bucket * DEMAND_BUCKET_SECONDS + bucketAlignSeconds(workdayStartMinute)) *
			1000,
		timeZone,
		workdayStartMinute,
	)
}

/** Net sales (subtotals) of counted online orders by business date and currency. */
export function orderSalesFacts(
	buckets: readonly OrderBucketRow[],
	timeZone: string,
	workdayStartMinute: number,
	range: { from: string; to: string },
): LaborSalesFact[] {
	const byKey = new Map<string, LaborSalesFact>()
	for (const row of buckets) {
		const date = bucketBusinessDate(row.bucket, timeZone, workdayStartMinute)
		if (date < range.from || date > range.to) continue
		const key = `${date}|${row.currency}`
		const fact = byKey.get(key) ?? {
			date,
			currency: row.currency,
			salesMinor: 0,
		}
		fact.salesMinor += row.subtotalMinor
		byKey.set(key, fact)
	}
	return [...byKey.values()].sort(
		(a, b) =>
			a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency),
	)
}
