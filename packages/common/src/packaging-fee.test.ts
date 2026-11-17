import { describe, expect, it } from 'vitest'
import { computePackagingFee } from './packaging-fee.ts'

describe('computePackagingFee', () => {
	it('charges per order on pickup only', () => {
		const result = computePackagingFee({
			settings: {
				enabled: true,
				mode: 'per_order',
				amountMinor: 100,
				fulfillments: ['pickup'],
				label: 'Packaging fee',
				taxable: false,
			},
			fulfillment: 'pickup',
			itemUnits: 3,
			taxRatePercent: 0,
			taxInclusive: false,
		})
		expect(result.feeCents).toBe(100)
	})

	it('skips dine-in', () => {
		const result = computePackagingFee({
			settings: {
				enabled: true,
				mode: 'per_order',
				amountMinor: 100,
				fulfillments: ['pickup', 'delivery'],
				label: 'Packaging fee',
				taxable: false,
			},
			fulfillment: 'dine_in',
			itemUnits: 2,
			taxRatePercent: 0,
			taxInclusive: false,
		})
		expect(result.feeCents).toBe(0)
	})
})
