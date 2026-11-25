import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { orderTimings } from '@repo/common/order-steps'
import {
	type ReportDefinition,
	type ReportRecord,
	resolveTimeframeRange,
} from '@repo/reports'
import { restaurantOrders, type TenantDatabase } from '@repo/tenant-db'
import { isValidTimeZone } from '@repo/reservations'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { loadOrderStepRows } from './order-steps.ts'
import { countedOrderCondition } from './report-records.ts'

/**
 * Records for the Order timings report (#243): one per online order that
 * counts toward sales, with the minutes from placed to accepted (for orders a
 * person had to accept), started and ready, and how late ready was against the
 * promised time. The times come from the append-only step rows
 * (`restaurant_order_steps`); an order from before they were recorded counts
 * as an order and has no minutes. Ids and numbers only: no guest data.
 */

export const ORDER_TIMING_MAX_ROWS = 50_000

export async function loadOrderTimingRecords(
	ctx: {
		db: TenantDatabase
		orgId: string
		locationIds: readonly string[] | null
		now: Date
	},
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	if (ctx.locationIds !== null && ctx.locationIds.length === 0) {
		return { records: [], truncated: false }
	}
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	// The columns hold epoch seconds.
	const conditions: SQL[] = [
		eq(restaurantOrders.orgId, ctx.orgId),
		countedOrderCondition(),
		sql`${restaurantOrders.createdAt} <= ${Math.floor(range.end.getTime() / 1000)}`,
	]
	if (range.start) {
		conditions.push(
			sql`${restaurantOrders.createdAt} >= ${Math.floor(range.start.getTime() / 1000)}`,
		)
	}
	if (ctx.locationIds !== null) {
		// bounded: the token's locations mirror the control plane's (well under 100).
		conditions.push(inArray(restaurantOrders.locationId, [...ctx.locationIds]))
	}
	const loaded = await ctx.db
		.select({
			id: restaurantOrders.id,
			createdAt: restaurantOrders.createdAt,
			locationId: restaurantOrders.locationId,
			locationName: restaurantOrders.locationName,
			locationTimezone: restaurantOrders.locationTimezone,
			pickupTimezone: restaurantOrders.pickupTimezone,
			fulfillment: restaurantOrders.fulfillment,
			promisedAt: restaurantOrders.promisedAt,
		})
		.from(restaurantOrders)
		.where(and(...conditions))
		.orderBy(desc(restaurantOrders.createdAt))
		.limit(ORDER_TIMING_MAX_ROWS + 1)
	const truncated = loaded.length > ORDER_TIMING_MAX_ROWS
	const rows = truncated ? loaded.slice(0, ORDER_TIMING_MAX_ROWS) : loaded
	const steps = await loadOrderStepRows(
		ctx.db,
		rows.map((row) => row.id),
	)
	const records = rows.flatMap((row): ReportRecord[] => {
		if (!row.createdAt) return []
		const timings = orderTimings(
			steps.get(row.id) ?? [],
			row.promisedAt ? row.promisedAt.getTime() : null,
		)
		const zone = [row.locationTimezone, row.pickupTimezone].find(
			(candidate): candidate is string =>
				Boolean(candidate) && isValidTimeZone(candidate!),
		)
		return [
			{
				placedAt: row.createdAt,
				location: getLocalizedMenuValue(row.locationName),
				locationId: row.locationId,
				fulfillment: row.fulfillment,
				locationTimeZone: zone ?? '',
				orders: 1,
				minutesToAccept: timings.minutesToAccept,
				minutesToStart: timings.minutesToStart,
				minutesToReady: timings.minutesToReady,
				minutesLate: timings.minutesLate,
				lateOrders: timings.late === 1 ? 1 : 0,
				promisedOrders: timings.late === null ? 0 : 1,
			},
		]
	})
	return { records, truncated }
}
