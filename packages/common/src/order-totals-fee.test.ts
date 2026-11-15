import { describe, expect, it } from 'vitest'
import {
	applyOrderDiscounts,
	defaultServiceFeeSettings,
	type ServiceFeeSettings,
} from './restaurant-orders.ts'

/**
 * Totals with a service fee (#123): discounts and rewards come off first, the
 * fee is worked out on what is left (before tax and tip), the tip stays on the
 * pre-discount subtotal and is never charged on the fee, and the fee's tax is
 * part of the order's tax.
 */

const fee = (patch: Partial<ServiceFeeSettings> = {}): ServiceFeeSettings => ({
	...defaultServiceFeeSettings('USD'),
	enabled: true,
	percentBp: 300,
	fulfillments: ['pickup'],
	...patch,
})

const priced = (
	patch: Partial<Parameters<typeof applyOrderDiscounts>[0]> = {},
	settings: ServiceFeeSettings | null = fee(),
) => ({
	// One 20.00 line, all of it taxable.
	lines: [{ totalCents: 2000, taxableCents: 2000 }] as never,
	subtotalCents: 2000,
	taxInclusive: false,
	taxRatePercent: 10,
	tipCents: 300,
	deliveryFeeCents: 0,
	serviceFeeRule: settings
		? { settings, fulfillment: 'pickup' as const }
		: null,
	...patch,
})

describe('applyOrderDiscounts with a service fee', () => {
	it('works the fee out on what discounts left, not on the tip', () => {
		const totals = applyOrderDiscounts(priced(), { '0': 1000 })
		// 10.00 left: 3 % = 0.30.
		expect(totals.serviceFeeCents).toBe(30)
		expect(totals.discountCents).toBe(1000)
		// 10.00 + tax 1.00 + tip 3.00 (pre-discount 15 %) + fee 0.30.
		expect(totals.totalCents).toBe(1000 + 100 + 300 + 30)
	})

	it('without a discount the fee is on the whole subtotal', () => {
		const totals = applyOrderDiscounts(priced(), {})
		expect(totals.serviceFeeCents).toBe(60)
		expect(totals.totalCents).toBe(2000 + 200 + 300 + 60)
	})

	it('has no fee when the discount takes everything off', () => {
		const totals = applyOrderDiscounts(
			priced({}, fee({ fixedMinor: 100 })),
			{ '0': 2000 },
		)
		expect(totals.serviceFeeCents).toBe(0)
		expect(totals.serviceFeeTaxCents).toBe(0)
		// Only the tip is left to pay.
		expect(totals.totalCents).toBe(300)
	})

	it('adds the tax on a taxable fee to the order tax and the total', () => {
		const totals = applyOrderDiscounts(priced({}, fee({ taxable: true })), {})
		// Fee 0.60, its tax 10 % = 0.06.
		expect(totals.serviceFeeCents).toBe(60)
		expect(totals.serviceFeeTaxCents).toBe(6)
		expect(totals.taxCents).toBe(200 + 6)
		expect(totals.totalCents).toBe(2000 + 206 + 300 + 60)
	})

	it('carves the tax out of the fee when prices include tax', () => {
		const totals = applyOrderDiscounts(
			priced({ taxInclusive: true }, fee({ taxable: true })),
			{},
		)
		// The 20.00 and the 0.60 both carry their tax: the total adds the fee only.
		expect(totals.serviceFeeCents).toBe(60)
		expect(totals.serviceFeeTaxCents).toBe(Math.round((60 * 10) / 110))
		expect(totals.totalCents).toBe(2000 + 300 + 60)
	})

	it('is the old total when no fee applies', () => {
		const totals = applyOrderDiscounts(priced({}, null), { '0': 500 })
		expect(totals.serviceFeeCents).toBe(0)
		expect(totals.totalCents).toBe(1500 + 150 + 300)
	})

	it('caps the fee and keeps the delivery discount separate from it', () => {
		const totals = applyOrderDiscounts(
			priced({ deliveryFeeCents: 400 }, fee({ capMinor: 25 })),
			{},
			400,
		)
		expect(totals.serviceFeeCents).toBe(25)
		expect(totals.deliveryDiscountCents).toBe(400)
		expect(totals.totalCents).toBe(2000 + 200 + 300 + 0 + 25)
	})
})
