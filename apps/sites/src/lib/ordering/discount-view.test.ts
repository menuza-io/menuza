import { describe, expect, it } from 'vitest'
import { receiptDiscounts } from './discount-view.ts'

const labels = {
	discount: 'Discount',
	deliveryDiscount: '{name} (delivery)',
	deliveryDiscountPlain: 'Delivery discount',
}

describe('receiptDiscounts', () => {
	it('reads a named snapshot, including the code and a delivery line', () => {
		const receipt = receiptDiscounts(
			{
				paymentStatus: 'paid',
				discountCents: 300,
				deliveryDiscountCents: 200,
				loyaltyDiscountCents: 100,
				discounts: [
					{
						discountId: 'd1',
						name: 'Lunch',
						code: 'LUNCH',
						amountMinor: 300,
						deliveryAmountMinor: 200,
					},
				],
			},
			labels,
		)
		expect(receipt.lines).toEqual([
			{
				key: 'd1:items',
				label: 'Lunch',
				code: 'LUNCH',
				amountMinor: 300,
				delivery: false,
			},
			{
				key: 'd1:delivery',
				label: 'Lunch (delivery)',
				code: 'LUNCH',
				amountMinor: 200,
				delivery: true,
			},
		])
		expect(receipt.itemsCents).toBe(300)
		expect(receipt.deliveryCents).toBe(200)
		expect(receipt.loyaltyCents).toBe(100)
		expect(receipt.free).toBe(false)
	})

	it('falls back to the totals when an older order has no snapshot', () => {
		const receipt = receiptDiscounts(
			{
				paymentStatus: 'not_required',
				discountCents: 500,
				deliveryDiscountCents: 150,
			},
			labels,
		)
		expect(receipt.lines.map((line) => line.label)).toEqual([
			'Discount',
			'Delivery discount',
		])
		expect(receipt.free).toBe(true)
	})

	it('ignores a missing or empty discount payload', () => {
		expect(receiptDiscounts({}, labels)).toEqual({
			lines: [],
			itemsCents: 0,
			deliveryCents: 0,
			loyaltyCents: 0,
			free: false,
		})
	})
})
