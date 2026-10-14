import { and, eq, sql } from 'drizzle-orm'
import { DEMAND_BUCKET_SECONDS, localDateOf, localParts } from '@repo/staffing'
import { restaurantOrders } from '@repo/tenant-db'
import {
	type OrderBucketRow,
	type OrderSource,
	registerOrderSource,
} from '../services/order-source.ts'
import { countedOrderCondition } from '../services/report-records.ts'

/**
 * The restaurant vertical's order source for the Staff module. A scope is an
 * organization location, so `scopeId` is the order's `locationId`. It returns
 * counts and money only, never a customer. An order counts when it is open or
 * completed and payable (handoff right away, online after payment succeeds).
 */
export const restaurantOrderSource: OrderSource = {
	async loadBuckets(db, scopeId, window) {
		const bucket = sql<number>`cast((${restaurantOrders.createdAt} - ${window.alignSeconds}) / ${DEMAND_BUCKET_SECONDS} as integer)`
		const rows = await db
			.select({
				bucket,
				currency: restaurantOrders.currency,
				fulfillment: restaurantOrders.fulfillment,
				orders: sql<number>`count(*)`,
				subtotalMinor: sql<number>`coalesce(sum(${restaurantOrders.subtotalCents}), 0)`,
				tipMinor: sql<number>`coalesce(sum(${restaurantOrders.tipCents}), 0)`,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.locationId, scopeId),
					sql`${restaurantOrders.createdAt} >= ${window.fromSeconds}`,
					sql`${restaurantOrders.createdAt} < ${window.toSeconds}`,
					countedOrderCondition(),
				),
			)
			.groupBy(bucket, restaurantOrders.currency, restaurantOrders.fulfillment)
		return rows.map((row): OrderBucketRow => ({
			bucket: Number(row.bucket),
			// Orders carry lowercase codes; pay rows use upper case.
			currency: row.currency.toUpperCase(),
			fulfillment: row.fulfillment,
			orders: Number(row.orders),
			subtotalMinor: Number(row.subtotalMinor),
			tipMinor: Number(row.tipMinor),
		}))
	},

	async loadBooked(db, scopeId, window) {
		const bucket = sql<number>`cast(${restaurantOrders.scheduledFor} / ${DEMAND_BUCKET_SECONDS} as integer)`
		const rows = await db
			.select({ bucket, orders: sql<number>`count(*)` })
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.locationId, scopeId),
					sql`${restaurantOrders.scheduledFor} is not null`,
					sql`${restaurantOrders.scheduledFor} >= ${window.fromSeconds}`,
					sql`${restaurantOrders.scheduledFor} < ${window.toSeconds}`,
					countedOrderCondition(),
				),
			)
			.groupBy(bucket)
		return rows.map((row) => {
			const startMs = Number(row.bucket) * DEMAND_BUCKET_SECONDS * 1000
			return {
				date: localDateOf(startMs, window.timeZone),
				hour: localParts(startMs, window.timeZone).hour,
				orders: Number(row.orders),
			}
		})
	},
}

/** Registers the restaurant order source; call once at startup. */
export function registerRestaurantOrderSource() {
	registerOrderSource(restaurantOrderSource)
}
