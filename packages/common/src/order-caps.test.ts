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

describe('checkOrderCaps by head count', () => {
	it('refuses a table over its guest cap and names which limit was hit', () => {
		const violation = checkOrderCaps({
			settings: { dineIn: { maxGuests: 4 } },
			fulfillment: 'dine_in',
			subtotalCents: 1_000,
			guestCount: 5,
		})
		expect(violation).toEqual({
			code: 'order_too_large',
			fulfillment: 'dine_in',
			kind: 'guests',
		})
	})

	it('lets a table at the cap, or one that did not say, through', () => {
		const settings = { dineIn: { maxGuests: 4 } }
		for (const guestCount of [4, 1, undefined, null]) {
			expect(
				checkOrderCaps({
					settings,
					fulfillment: 'dine_in',
					subtotalCents: 1_000,
					guestCount,
				}),
			).toBeNull()
		}
	})

	it('never applies the amount cap to a table, or the guest cap to a pickup', () => {
		expect(
			checkOrderCaps({
				settings: {
					pickup: { maxSubtotalMinor: 100 },
					dineIn: { maxGuests: 4 },
				},
				fulfillment: 'dine_in',
				subtotalCents: 999_999,
				guestCount: 2,
			}),
		).toBeNull()
		expect(
			checkOrderCaps({
				settings: { dineIn: { maxGuests: 1 } },
				fulfillment: 'pickup',
				subtotalCents: 999_999,
				guestCount: 50,
			}),
		).toBeNull()
	})

	it('says amount when both limits are over, since the amount is checked first', () => {
		expect(
			checkOrderCaps({
				settings: { pickup: { maxSubtotalMinor: 5_000, maxGuests: 2 } },
				fulfillment: 'pickup',
				subtotalCents: 6_000,
				guestCount: 9,
			})?.kind,
		).toBe('amount')
	})

	it('has no cap when nothing is set', () => {
		expect(
			checkOrderCaps({
				settings: null,
				fulfillment: 'delivery',
				subtotalCents: 999_999,
			}),
		).toBeNull()
		expect(
			checkOrderCaps({
				settings: { pickup: {} },
				fulfillment: 'pickup',
				subtotalCents: 999_999,
			}),
		).toBeNull()
	})
})
