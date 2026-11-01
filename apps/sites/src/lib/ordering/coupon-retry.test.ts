import { describe, expect, it } from 'vitest'
import {
	attemptKey,
	couponContextKey,
	shouldRetryHeldCoupon,
} from './coupon-retry.ts'

const pickup = {
	fulfillment: 'pickup',
	locationId: 'loc_1',
	lines: [{ itemId: 'a', quantity: 1 }],
}
const delivery = {
	...pickup,
	fulfillment: 'delivery',
	delivery: { address: '1 Main Street', quoteToken: 'q' },
}

describe('couponContextKey', () => {
	it('is null while the order cannot be priced', () => {
		expect(couponContextKey(null)).toBeNull()
	})

	it('changes with order type, location, time and address, not with the cart', () => {
		const base = couponContextKey(pickup)
		expect(couponContextKey({ ...pickup, lines: [] })).toBe(base)
		expect(couponContextKey(delivery)).not.toBe(base)
		expect(couponContextKey({ ...pickup, locationId: 'loc_2' })).not.toBe(base)
		expect(
			couponContextKey({ ...pickup, scheduledFor: '2026-11-01T12:00:00Z' }),
		).not.toBe(base)
		expect(
			couponContextKey({
				...delivery,
				delivery: { address: '2 Side Road', quoteToken: 'q' },
			}),
		).not.toBe(couponContextKey(delivery))
	})
})

describe('shouldRetryHeldCoupon', () => {
	const pickupKey = couponContextKey(pickup)!
	const deliveryKey = couponContextKey(delivery)!
	const held = {
		code: 'PICKUP10',
		reason: 'not_found' as const,
		contextKey: pickupKey,
	}

	it('tries a held not-found code again when the order type changed', () => {
		expect(shouldRetryHeldCoupon(held, deliveryKey, new Set())).toBe(true)
	})

	it('does not retry in the same context or one already tried', () => {
		expect(shouldRetryHeldCoupon(held, pickupKey, new Set())).toBe(false)
		expect(
			shouldRetryHeldCoupon(
				held,
				deliveryKey,
				new Set([attemptKey('pickup10', deliveryKey)]),
			),
		).toBe(false)
	})

	it('does not retry while the order cannot be priced', () => {
		expect(shouldRetryHeldCoupon(held, null, new Set())).toBe(false)
	})

	it('never retries a refusal the page made itself or a real reason', () => {
		expect(
			shouldRetryHeldCoupon(
				{ code: 'X', reason: 'not_found' },
				deliveryKey,
				new Set(),
			),
		).toBe(false)
		expect(
			shouldRetryHeldCoupon(
				{ ...held, reason: 'limit_reached' },
				deliveryKey,
				new Set(),
			),
		).toBe(false)
		expect(shouldRetryHeldCoupon(null, deliveryKey, new Set())).toBe(false)
	})
})
