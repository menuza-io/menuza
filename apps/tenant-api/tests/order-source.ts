import { localDateOf, localParts } from '@repo/staffing'
import {
	type OrderBucketRow,
	type OrderSource,
} from '../src/services/order-source.ts'

/**
 * An in-memory order source for tests of the demand guide, the forecast and the
 * labor summary. The generic module keeps no orders; this stands in for the
 * source a vertical registers. An order counts unless it is cancelled or an
 * online order that is not yet paid, the rule the tests below rely on.
 */
export type FakeOrder = {
	atMs: number
	scopeId: string
	subtotalCents: number
	tipCents: number
	currency: string
	fulfillment: 'pickup' | 'delivery'
	status: string
	paymentMethod: string
	paymentStatus: string
	scheduledFor?: Date
}

export type FakeOrderOverrides = Partial<Omit<FakeOrder, 'atMs'>> & {
	/** Ignored extras a test may carry over from a richer order record. */
	cancelledAt?: Date
}

const BUCKET_SECONDS = 15 * 60

export function createFakeOrderSource(defaultScopeId: string) {
	const orders: FakeOrder[] = []
	const counted = (order: FakeOrder) =>
		order.status !== 'cancelled' &&
		!(order.paymentMethod === 'online' && order.paymentStatus !== 'paid')

	const source: OrderSource = {
		async loadBuckets(_db, scopeId, window) {
			const rows = new Map<string, OrderBucketRow>()
			for (const order of orders) {
				const seconds = Math.floor(order.atMs / 1000)
				if (
					order.scopeId !== scopeId ||
					!counted(order) ||
					seconds < window.fromSeconds ||
					seconds >= window.toSeconds
				) {
					continue
				}
				const bucket = Math.floor(
					(seconds - window.alignSeconds) / BUCKET_SECONDS,
				)
				const currency = order.currency.toUpperCase()
				const key = `${bucket}|${currency}|${order.fulfillment}`
				const row = rows.get(key) ?? {
					bucket,
					currency,
					fulfillment: order.fulfillment,
					orders: 0,
					subtotalMinor: 0,
					tipMinor: 0,
				}
				row.orders += 1
				row.subtotalMinor += order.subtotalCents
				row.tipMinor += order.tipCents
				rows.set(key, row)
			}
			return [...rows.values()]
		},
		async loadBooked(_db, scopeId, window) {
			const rows = new Map<
				number,
				{ date: string; hour: number; orders: number }
			>()
			for (const order of orders) {
				if (order.scopeId !== scopeId || !counted(order)) continue
				if (!order.scheduledFor) continue
				const seconds = Math.floor(order.scheduledFor.getTime() / 1000)
				if (seconds < window.fromSeconds || seconds >= window.toSeconds) {
					continue
				}
				const bucket = Math.floor(seconds / BUCKET_SECONDS)
				const startMs = bucket * BUCKET_SECONDS * 1000
				const row = rows.get(bucket) ?? {
					date: localDateOf(startMs, window.timeZone),
					hour: localParts(startMs, window.timeZone).hour,
					orders: 0,
				}
				row.orders += 1
				rows.set(bucket, row)
			}
			return [...rows.values()]
		},
	}

	return {
		source,
		add(atMs: number, overrides: FakeOrderOverrides = {}) {
			const { cancelledAt: ignoredCancelledAt, ...rest } = overrides
			orders.push({
				atMs,
				scopeId: defaultScopeId,
				subtotalCents: 1000,
				tipCents: 0,
				currency: 'usd',
				fulfillment: 'pickup',
				status: 'completed',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				...rest,
			})
		},
		clear() {
			orders.length = 0
		},
	}
}
