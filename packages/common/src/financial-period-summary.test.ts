import { describe, expect, it } from 'vitest'
import { summarizeFinancialPeriod } from './financial-period-summary.ts'

describe('financial period summary', () => {
	it('totals equal the sum of orders', () => {
		const rows = [
			{
				netMinor: 1000,
				grossMinor: 1100,
				discountMinor: 100,
				taxMinor: 80,
				tipMinor: 50,
				serviceFeeMinor: 20,
				packagingFeeMinor: 10,
				refundMinor: 0,
				taxByRateBp: [{ rateBp: 1500, taxMinor: 80 }],
			},
			{
				netMinor: 500,
				grossMinor: 500,
				discountMinor: 0,
				taxMinor: 40,
				tipMinor: 0,
				serviceFeeMinor: 0,
				packagingFeeMinor: 0,
				refundMinor: 0,
				taxByRateBp: [{ rateBp: 1500, taxMinor: 40 }],
			},
		]
		const summary = summarizeFinancialPeriod(rows)
		expect(summary.orderCount).toBe(2)
		expect(summary.netSalesMinor).toBe(1500)
		expect(summary.taxMinor).toBe(120)
		expect(summary.taxByRate).toEqual([{ rateBp: 1500, taxMinor: 120 }])
	})
})
