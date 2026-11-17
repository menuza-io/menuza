import { describe, expect, it } from 'vitest'
import { checkOrderCaps } from './order-caps.ts'

describe('checkOrderCaps', () => {
	it('refuses when subtotal exceeds pickup cap', () => {
		const violation = checkOrderCaps({
			settings: { pickup: { maxSubtotalMinor: 5000 } },
			fulfillment: 'pickup',
			subtotalCents: 5001,
		})
		expect(violation?.code).toBe('order_too_large')
	})

	it('allows when under cap', () => {
		expect(
			checkOrderCaps({
				settings: { pickup: { maxSubtotalMinor: 5000 } },
				fulfillment: 'pickup',
				subtotalCents: 4999,
			}),
		).toBeNull()
	})
})
