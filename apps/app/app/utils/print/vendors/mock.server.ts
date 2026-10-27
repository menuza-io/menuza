import {
	type PrintVendor,
	type PrintVendorName,
	type VendorOrderState,
} from './types.ts'

/**
 * Stateless vendor emulator (`PRINT_MOCK=true`). Prices are derived from the
 * SKU so quotes are stable; an order id encodes its creation time, and its
 * status moves on with the clock: submitted for 1 minute (cancellable), then
 * in production, then shipped with a tracking number after 3 minutes.
 */

function skuCents(sku: string): number {
	let hash = 0
	for (const char of sku) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
	return 300 + (hash % 1700)
}

export function createMockVendor(as: PrintVendorName = 'mock'): PrintVendor {
	return {
		name: as,
		async quote(items) {
			const itemsCents = items.reduce(
				(sum, item) => sum + skuCents(item.sku) * item.quantity,
				0,
			)
			return {
				itemsCents,
				shippingCents: 499 + Math.min(items.length, 5) * 100,
				shippingMethod: 'mock-standard',
				currency: 'USD',
			}
		},
		async createOrder({ reference }) {
			return { vendorOrderId: `mock_${Date.now()}_${reference}` }
		},
		async status(vendorOrderId) {
			const createdAt = Number(vendorOrderId.split('_')[1] ?? Date.now())
			const age = Date.now() - createdAt
			const state: VendorOrderState =
				age < 60_000 ? 'submitted' : age < 180_000 ? 'in_production' : 'shipped'
			return {
				state,
				carrier: state === 'shipped' ? 'Mock Post' : null,
				trackingNumber: state === 'shipped' ? `MOCK${createdAt}` : null,
				trackingUrl: null,
			}
		},
		async cancel(vendorOrderId) {
			const createdAt = Number(vendorOrderId.split('_')[1] ?? 0)
			return Date.now() - createdAt < 60_000 ? 'cancelled' : 'too_late'
		},
	}
}
