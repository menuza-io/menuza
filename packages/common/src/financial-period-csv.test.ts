import { describe, expect, it } from 'vitest'
import { financialPeriodToCsv } from './financial-period-csv.ts'
import { summarizeFinancialPeriod } from './financial-period-summary.ts'

describe('financial period CSV', () => {
	it('matches the on-screen totals', () => {
		const summary = summarizeFinancialPeriod([
			{
				netMinor: 1000,
				grossMinor: 1100,
				discountMinor: 100,
				taxMinor: 80,
				tipMinor: 0,
				serviceFeeMinor: 0,
				packagingFeeMinor: 0,
				refundMinor: 0,
				taxByRateBp: [{ rateBp: 1500, taxMinor: 80 }],
			},
		])
		const csv = financialPeriodToCsv(summary)
		expect(csv).toContain('Net sales,1000')
		expect(csv).toContain('Tax,80')
		expect(csv).toContain('Tax @ 15%,80')
	})
})
