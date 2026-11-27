import { describe, expect, it } from 'vitest'
import { computeOrderTaxCents, explainOrderMoney } from './order-money.ts'
import { computeTip } from './order-tips.ts'
import { computeServiceFee, type ServiceFeeSettings } from './service-fee.ts'

const DEFAULT_RATES = {
	cardProcessingBp: 290, // 2.9%
	cardProcessingFixedCents: 30, // $0.30
	platformFeeBp: 0,
}

const SAMPLE_SERVICE_FEE: ServiceFeeSettings = {
	enabled: true,
	label: 'Online service fee',
	explanation: null,
	percentBp: 500, // 5%
	fixedMinor: 50, // $0.50
	capMinor: null,
	smallOrderBelowMinor: null,
	smallOrderFeeMinor: null,
	taxable: false,
	fulfillments: ['pickup', 'delivery'],
}

describe('explainOrderMoney (#288)', () => {
	it('matches checkout pricing helpers exactly for the guest column', () => {
		const subtotalCents = 4000
		const taxRateBp = 825
		const deliveryFeeCents = 500

		const result = explainOrderMoney(
			{
				subtotalCents,
				orderType: 'delivery',
				paymentMethod: 'card',
				tipPercent: 15,
			},
			{
				currency: 'USD',
				taxRateBp,
				pricesIncludeTax: false,
				serviceFee: SAMPLE_SERVICE_FEE,
				deliveryFeeCents,
				deliveryFeePayer: 'guest',
			},
			DEFAULT_RATES,
		)

		const expectedServiceFee = computeServiceFee({
			settings: SAMPLE_SERVICE_FEE,
			fulfillment: 'delivery',
			baseCents: subtotalCents,
			taxRatePercent: taxRateBp / 100,
			taxInclusive: false,
		})
		const expectedTip = computeTip({
			tip: { percent: 15 },
			subtotalCents,
			currency: 'USD',
		})
		const expectedTax =
			computeOrderTaxCents(subtotalCents, taxRateBp, false) +
			expectedServiceFee.taxCents

		expect(expectedTip.ok).toBe(true)
		const expectedTotal =
			subtotalCents +
			expectedTax +
			expectedServiceFee.feeCents +
			deliveryFeeCents +
			(expectedTip.ok ? expectedTip.tipCents : 0)

		expect(result.guest.totalCents).toBe(expectedTotal)
		expect(result.breakdown.serviceFeeCents).toBe(expectedServiceFee.feeCents)
		expect(result.breakdown.tipCents).toBe(
			expectedTip.ok ? expectedTip.tipCents : 0,
		)
		expect(result.restaurant.netPayoutCents).toBe(
			expectedTotal - result.breakdown.cardProcessingFeeCents,
		)
	})

	it('changes both columns when who pays a fee changes in settings', () => {
		const guestPaysDelivery = explainOrderMoney(
			{ subtotalCents: 4000, orderType: 'delivery', paymentMethod: 'card' },
			{
				currency: 'USD',
				taxRateBp: 800,
				pricesIncludeTax: false,
				deliveryFeeCents: 500,
				deliveryFeePayer: 'guest',
			},
			DEFAULT_RATES,
		)
		const restaurantPaysDelivery = explainOrderMoney(
			{ subtotalCents: 4000, orderType: 'delivery', paymentMethod: 'card' },
			{
				currency: 'USD',
				taxRateBp: 800,
				pricesIncludeTax: false,
				deliveryFeeCents: 500,
				deliveryFeePayer: 'restaurant',
			},
			DEFAULT_RATES,
		)
		expect(guestPaysDelivery.guest.totalCents).toBe(
			restaurantPaysDelivery.guest.totalCents + 500,
		)
		expect(restaurantPaysDelivery.restaurant.netPayoutCents).toBeLessThan(
			guestPaysDelivery.restaurant.netPayoutCents,
		)

		const restaurantPaysCard = explainOrderMoney(
			{ subtotalCents: 4000, orderType: 'pickup', paymentMethod: 'card' },
			{
				currency: 'USD',
				taxRateBp: 0,
				pricesIncludeTax: false,
				cardFeePayer: 'restaurant',
			},
			DEFAULT_RATES,
		)
		const guestPaysCard = explainOrderMoney(
			{ subtotalCents: 4000, orderType: 'pickup', paymentMethod: 'card' },
			{
				currency: 'USD',
				taxRateBp: 0,
				pricesIncludeTax: false,
				cardFeePayer: 'guest',
			},
			DEFAULT_RATES,
		)
		expect(guestPaysCard.guest.totalCents).toBeGreaterThan(
			restaurantPaysCard.guest.totalCents,
		)
		expect(guestPaysCard.restaurant.netPayoutCents).toBeGreaterThan(
			restaurantPaysCard.restaurant.netPayoutCents,
		)
	})

	it('hides zero/unconfigured lines and charges no card/platform fee on cash', () => {
		const cashPickup = explainOrderMoney(
			{ subtotalCents: 2500, orderType: 'pickup', paymentMethod: 'cash' },
			{
				currency: 'USD',
				taxRateBp: 800,
				pricesIncludeTax: false,
				serviceFee: null,
			},
			{
				cardProcessingBp: 290,
				cardProcessingFixedCents: 30,
				platformFeeBp: 200,
			},
		)
		const guestKinds = cashPickup.guest.lines.map((l) => l.kind)
		expect(guestKinds).toEqual(['subtotal', 'tax'])
		expect(cashPickup.restaurant.lines.map((l) => l.kind)).toEqual([
			'gross_collected',
		])
		expect(cashPickup.restaurant.netPayoutCents).toBe(
			cashPickup.guest.totalCents,
		)
	})
})
