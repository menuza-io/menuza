import { describe, expect, it } from 'vitest'
import { posSalesSummary } from './pos-reports.ts'

const order = (
	status: 'open' | 'paid' | 'void' | 'refunded',
	totalCents: number,
	taxCents = 0,
	tipCents = 0,
	lineVoids: Array<{ quantity: number; unitCents: number }> = [],
) => ({
	status,
	totals: { totalCents, taxCents, tipCents },
	lineVoids,
})

describe('posSalesSummary', () => {
	it('adds up sales, tax, tips, refunds and cancellations, and what the drawer should hold', () => {
		const summary = posSalesSummary({
			orders: [
				order('paid', 1150, 150, 0, [{ quantity: 2, unitCents: 400 }]),
				order('refunded', 2300, 300, 100),
				order('void', 900),
				order('open', 500),
			],
			payments: [
				{ method: 'cash', amountCents: 1150 },
				{ method: 'card', amountCents: 2300 },
			],
			refunds: [{ method: 'card', amountCents: 2300, taxCents: 300 }],
			openingFloatCents: 10_000,
			movements: [
				{ kind: 'pay_in', amountCents: 500 },
				{ kind: 'pay_out', amountCents: 2000 },
			],
		})
		expect(summary.orders).toEqual({
			paid: 1,
			refunded: 1,
			cancelled: 1,
			open: 1,
		})
		expect(summary).toMatchObject({
			grossSalesCents: 3450,
			refundsCents: 2300,
			netSalesCents: 1150,
			taxCents: 150,
			tipsCents: 100,
		})
		expect(summary.byTender.card).toEqual({
			paymentsCents: 2300,
			refundsCents: 2300,
			netCents: 0,
		})
		expect(summary.voids).toEqual({
			cancelledOrders: 1,
			cancelledCents: 900,
			removedItems: 2,
			removedCents: 800,
		})
		expect(summary.cash).toEqual({
			openingFloatCents: 10_000,
			paymentsCents: 1150,
			refundsCents: 0,
			payInsCents: 500,
			payOutsCents: 2000,
			expectedCents: 9650,
		})
	})

	it('reports discounts and the items before them when the orders carry them', () => {
		const sale = (
			status: 'paid' | 'refunded' | 'void' | 'open',
			totalCents: number,
			subtotalCents?: number,
			discountCents?: number,
		) => ({
			...order(status, totalCents),
			...(subtotalCents === undefined ? {} : { subtotalCents }),
			...(discountCents === undefined ? {} : { discountCents }),
		})
		const summary = posSalesSummary({
			orders: [
				sale('paid', 1000, 1000, 0),
				sale('paid', 1590, 2000, 500),
				sale('refunded', 575, 600, 100),
				// Cancelled and open sales are not sales.
				sale('void', 900, 900, 0),
				sale('open', 500, 500, 50),
			],
			payments: [],
			refunds: [],
		})
		expect(summary.grossBeforeDiscountsCents).toBe(3600)
		expect(summary.discountCents).toBe(600)
		expect(summary.loyaltyDiscountCents).toBe(0)
		// Sales is after discounts, as it always was.
		expect(summary.grossSalesCents).toBe(3165)
	})

	it('keeps loyalty rewards out of discounts, and tax and tips out of the gross before them', () => {
		const summary = posSalesSummary({
			orders: [
				{
					status: 'paid',
					// 2000 of items, 300 discount, 200 reward, 150 tax, 100 tip.
					totals: { taxCents: 150, tipCents: 100, totalCents: 1750 },
					subtotalCents: 2000,
					discountCents: 300,
					loyaltyDiscountCents: 200,
					lineVoids: [],
				},
			],
			payments: [],
			refunds: [],
		})
		expect(summary.grossBeforeDiscountsCents).toBe(2000)
		expect(summary.discountCents).toBe(300)
		expect(summary.loyaltyDiscountCents).toBe(200)
		expect(summary.grossSalesCents).toBe(1750)
	})

	it('leaves the discount figures out when a sale does not say, instead of a false zero', () => {
		const summary = posSalesSummary({
			orders: [
				{ ...order('paid', 1000), subtotalCents: 1000, discountCents: 0 },
				order('paid', 500),
			],
			payments: [],
			refunds: [],
		})
		expect(summary).not.toHaveProperty('discountCents')
		expect(summary).not.toHaveProperty('grossBeforeDiscountsCents')
		expect(summary.grossSalesCents).toBe(1500)
	})
})
