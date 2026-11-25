import { describe, expect, it } from 'vitest'
import {
	deliveryFeeForCart,
	deliveryFeeHint,
	readCartSubtotal,
} from './delivery-fee.ts'

const pricing = {
	baseFee: 5,
	steps: [
		{ from: 10, fee: 5 },
		{ from: 20, fee: 3 },
		{ from: 40, fee: 0 },
	],
	byDistance: false,
}

describe('deliveryFeeForCart (#244)', () => {
	it('prices the cart with the verified address pricing', () => {
		const delivery = { deliveryFee: 5, pricing }
		expect(deliveryFeeForCart(delivery, 12)).toBe(5)
		expect(deliveryFeeForCart(delivery, 25)).toBe(3)
		// Above the last step: free.
		expect(deliveryFeeForCart(delivery, 80)).toBe(0)
	})

	it('keeps the single fee for details saved before fee tables', () => {
		expect(deliveryFeeForCart({ deliveryFee: 3.99 }, 80)).toBe(3.99)
		expect(deliveryFeeForCart(null, 80)).toBe(0)
	})
})

describe('deliveryFeeHint (#244)', () => {
	const delivery = { deliveryFee: 5, pricing }

	it('says how much more unlocks the next cheaper step', () => {
		expect(deliveryFeeHint(delivery, 14)).toEqual({ remaining: 6, fee: 3 })
		expect(deliveryFeeHint(delivery, 34)).toEqual({ remaining: 6, fee: 0 })
	})

	it('says nothing at the last step, without a table or with an empty cart', () => {
		expect(deliveryFeeHint(delivery, 50)).toBeNull()
		expect(deliveryFeeHint({ deliveryFee: 5 }, 14)).toBeNull()
		expect(deliveryFeeHint(delivery, 0)).toBeNull()
		expect(deliveryFeeHint(null, 14)).toBeNull()
	})
})

describe('readCartSubtotal', () => {
	const storage = (value: string | null) => ({ getItem: () => value })

	it('sums the saved lines', () => {
		expect(
			readCartSubtotal(
				'org',
				storage(
					JSON.stringify([
						{ unitPrice: 4.5, quantity: 2 },
						{ unitPrice: 1, quantity: 3 },
					]),
				),
			),
		).toBe(12)
	})

	it('is zero for an empty, missing or unreadable cart', () => {
		expect(readCartSubtotal('org', storage(null))).toBe(0)
		expect(readCartSubtotal('org', storage('not json'))).toBe(0)
		expect(readCartSubtotal('org', storage('{"a":1}'))).toBe(0)
		expect(readCartSubtotal('org', null)).toBe(0)
		expect(
			readCartSubtotal('org', storage(JSON.stringify([{ unitPrice: 'x', quantity: 1 }]))),
		).toBe(0)
	})
})
