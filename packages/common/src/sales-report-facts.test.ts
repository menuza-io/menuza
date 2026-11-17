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

describe('restaurantSaleMoney with a packaging fee (#408)', () => {
	const base = {
		subtotalCents: 2000,
		discountCents: 0,
		loyaltyDiscountCents: 0,
		tipCents: 0,
		deliveryFeeCents: 0,
		deliveryDiscountCents: 0,
	}

	it('counts the fee as a sale, not as item sales, and keeps its tax out of the items', () => {
		// Prices exclude tax: items 20.00 + packaging 1.00, 10 % tax on both.
		const money = restaurantSaleMoney({
			...base,
			taxCents: 210,
			totalCents: 2000 + 100 + 210,
			packagingFeeCents: 100,
			packagingFeeTaxCents: 10,
		})
		expect(money.netMinor).toBe(2100)
		expect(money.grossMinor).toBe(2100)
		expect(money.taxMinor).toBe(210)
		expect(money.totalMinor).toBe(2310)
	})

	it('still reads a tax-inclusive order correctly when the fee is in the total', () => {
		// Inclusive: items 20.00 incl. 1.82 tax, packaging 1.10 incl. 0.10 tax.
		const money = restaurantSaleMoney({
			...base,
			taxCents: 192,
			totalCents: 2000 + 110,
			packagingFeeCents: 110,
			packagingFeeTaxCents: 10,
		})
		// Net items = 20.00 - 1.82; plus the 1.10 packaging fee as a sale.
		expect(money.netMinor).toBe(2000 - 182 + 110)
	})

	it('is unchanged for an order without a packaging fee', () => {
		const without = restaurantSaleMoney({
			...base,
			taxCents: 200,
			totalCents: 2200,
		})
		const zero = restaurantSaleMoney({
			...base,
			taxCents: 200,
			totalCents: 2200,
			packagingFeeCents: 0,
			packagingFeeTaxCents: 0,
		})
		expect(zero).toEqual(without)
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
