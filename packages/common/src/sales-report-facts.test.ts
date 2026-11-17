import { describe, expect, it } from 'vitest'
import {
	posSaleMoney,
	restaurantSaleMoney,
	saleAmountMinor,
} from './sales-report-facts.ts'

describe('restaurantSaleMoney', () => {
	it('splits gross 4000 and net 3500 minor units before tax and tips', () => {
		const money = restaurantSaleMoney({
			subtotalCents: 4000,
			discountCents: 500,
			loyaltyDiscountCents: 0,
			taxCents: 300,
			tipCents: 600,
			deliveryFeeCents: 0,
			deliveryDiscountCents: 0,
			totalCents: 4400,
		})
		expect(money.grossMinor).toBe(4000)
		expect(money.netMinor).toBe(3500)
		expect(saleAmountMinor(money, 'gross')).toBe(4000)
		expect(saleAmountMinor(money, 'net')).toBe(3500)
	})
})

describe('posSaleMoney', () => {
	it('treats adjustments as discounts and loyalty separately', () => {
		const money = posSaleMoney({
			subtotalCents: 2000,
			adjustmentCents: 400,
			taxCents: 0,
			tipCents: 0,
			totalCents: 1600,
			taxInclusive: false,
			adjustments: [{ kind: 'loyalty', amountCents: 100 }],
		})
		expect(money.netMinor).toBe(1600)
		expect(money.grossMinor).toBe(2000)
		expect(money.loyaltyMinor).toBe(100)
		expect(money.discountMinor).toBe(300)
	})
})
