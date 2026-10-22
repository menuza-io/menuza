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
})
