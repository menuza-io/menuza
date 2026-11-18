// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { summarizeFinancialPeriod } from '@repo/common/financial-period-summary'
import { financialPeriodToCsv } from '@repo/common/financial-period-csv'
import { describe, expect, it } from 'vitest'

describe('financial summary CSV', () => {
	it('export matches on-screen totals', () => {
		const summary = summarizeFinancialPeriod([
			{
				netMinor: 5000,
				grossMinor: 5000,
				discountMinor: 0,
				taxMinor: 400,
				tipMinor: 0,
				serviceFeeMinor: 0,
				packagingFeeMinor: 0,
				refundMinor: 0,
				taxByRateBp: [{ rateBp: 800, taxMinor: 400 }],
			},
		])
		const csv = financialPeriodToCsv(summary)
		expect(csv).toContain(`Net sales,${summary.netSalesMinor}`)
		expect(csv).toContain(`Tax,${summary.taxMinor}`)
	})
})

describe('FinancialSummaryPage i18n', () => {
	it('loads lingui', () => {
		expect(i18n).toBeDefined()
		expect(I18nProvider).toBeDefined()
	})
})
