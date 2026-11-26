import { describe, expect, it } from 'vitest'
import { computeTotals, type CartLine } from './pricing.ts'

const sampleLines: CartLine[] = [
	{
		id: 'l1',
		itemId: 'item-1',
		name: 'Kabsa',
		variantId: null,
		variantLabel: null,
		quantity: 2,
		baseCents: 2500,
		instructions: '',
		options: [],
	},
]

describe('Station pricing: tax-exempt (#166), delivery fee (#164), service charge (#397)', () => {
	it('removes all tax when marked tax-exempt', () => {
		const normal = computeTotals({
			lines: sampleLines,
			taxRatePercent: 10,
			taxInclusive: false,
		})
		expect(normal.taxCents).toBe(500)
		expect(normal.totalCents).toBe(5500)

		const exempt = computeTotals({
			lines: sampleLines,
			taxRatePercent: 10,
			taxInclusive: false,
			taxExempt: true,
		})
		expect(exempt.taxCents).toBe(0)
		expect(exempt.totalCents).toBe(5000)
	})

	it('adds phone delivery fee and 12% dine-in service charge with VAT', () => {
		const withDelivery = computeTotals({
			lines: sampleLines,
			taxRatePercent: 10,
			taxInclusive: false,
			deliveryFeeCents: 450,
		})
		expect(withDelivery.deliveryFeeCents).toBe(450)
		expect(withDelivery.totalCents).toBe(5950) // 5000 + 500 tax + 450 delivery

		const withServiceCharge = computeTotals({
			lines: sampleLines,
			taxRatePercent: 15,
			taxInclusive: false,
			serviceChargeCents: 600, // 12% of 5000
			serviceChargeTaxCents: 90, // 15% VAT on 600
		})
		expect(withServiceCharge.serviceChargeCents).toBe(600)
		expect(withServiceCharge.taxCents).toBe(840) // 750 + 90
		expect(withServiceCharge.totalCents).toBe(6440) // 5000 + 600 + 840
	})
})
