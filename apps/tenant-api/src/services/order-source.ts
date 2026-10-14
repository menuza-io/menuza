import { type BookedOrderFact } from '@repo/staffing'
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
	fulfillment: 'pickup' | 'delivery'
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

/** Registers the vertical's order source; `null` removes it. */
export function registerOrderSource(source: OrderSource | null) {
	current = source
}

export function getOrderSource(): OrderSource | null {
	return current
}
