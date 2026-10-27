import { type BookedOrderFact } from '@repo/staffing'
import { registerDemandSource } from './demand-sources.ts'
import { type StaffDb } from './staff-audit.ts'

/**
 * Where the demand guide, the forecast and the labor summary read orders from.
 *
 * The generic Staff module keeps no orders, so by default there is no source:
 * the demand guide is empty and labor sales are the figures a team enters. A
 * vertical that takes orders registers a source once at startup. It only ever
 * returns counts and money for one scope and window, never a customer.
 */

/** Counted orders of one scope in a 15-minute bucket, per currency and fulfillment type. */
export type OrderBucketRow = {
	bucket: number
	currency: string
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	orders: number
	subtotalMinor: number
	tipMinor: number
}

export type OrderSource = {
	/**
	 * Counted orders placed in `[fromSeconds, toSeconds)`, grouped into buckets
	 * of 15 minutes aligned `alignSeconds` past the epoch. Currencies are upper case.
	 */
	loadBuckets(
		db: StaffDb,
		scopeId: string,
		window: { fromSeconds: number; toSeconds: number; alignSeconds: number },
	): Promise<OrderBucketRow[]>
	/** Orders already booked for an hour in `[fromSeconds, toSeconds)`, in local hours. */
	loadBooked(
		db: StaffDb,
		scopeId: string,
		window: { fromSeconds: number; toSeconds: number; timeZone: string },
	): Promise<BookedOrderFact[]>
}

let current: OrderSource | null = null

/**
 * Registers the vertical's order source; `null` removes it. It also registers
 * the `orders` demand source, so the forecast reads it through the registry.
 */
export function registerOrderSource(source: OrderSource | null) {
	current = source
	if (!source) {
		registerDemandSource({ id: 'orders', remove: true })
		return
	}
	registerDemandSource({
		id: 'orders',
		unit: 'orders',
		async loadBuckets(db, scopeId, window) {
			// The same rows `getOrderSource()` serves, counted per bucket.
			const rows = await source.loadBuckets(db, scopeId, window)
			const byBucket = new Map<number, number>()
			for (const row of rows) {
				byBucket.set(row.bucket, (byBucket.get(row.bucket) ?? 0) + row.orders)
			}
			return [...byBucket].map(([bucket, units]) => ({ bucket, units }))
		},
		async loadBooked(db, scopeId, window) {
			const facts = await source.loadBooked(db, scopeId, window)
			return facts.map((fact) => ({
				date: fact.date,
				hour: fact.hour,
				units: fact.orders,
			}))
		},
	})
}

export function getOrderSource(): OrderSource | null {
	return current
}
