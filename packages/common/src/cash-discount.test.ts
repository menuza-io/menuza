import { describe, expect, it } from 'vitest'
import {
	CASH_DISCOUNT_ADJUSTMENT_ID,
	CASH_DISCOUNT_MAX_BP,
	PAYMENT_PRICING_RULES,
	cashDiscountAllowedIn,
	cashDiscountBlock,
	cashDiscountCents,
	cashDiscountCeilingCents,
	readCashDiscountBp,
} from './cash-discount.ts'
import {
	DEFAULT_POS_LOCATION_STATION_SETTINGS,
	POS_CONTRACT_VERSION,
	parsePosLocationStationSettings,
	posAdjustmentSchema,
} from './pos-orders.ts'
import { posSaleMoney, restaurantSaleMoney } from './sales-report-facts.ts'
import { posSalesSummary } from './pos-reports.ts'

describe('where a cash discount is allowed (#375)', () => {
	it('is a table by data region: the US yes, KSA no, anything else no', () => {
		expect(PAYMENT_PRICING_RULES.us.cashDiscount).toBe(true)
		expect(PAYMENT_PRICING_RULES.ksa.cashDiscount).toBe(false)
		expect(cashDiscountAllowedIn('us')).toBe(true)
		expect(cashDiscountAllowedIn('ksa')).toBe(false)
		expect(cashDiscountAllowedIn('eu')).toBe(false)
		expect(cashDiscountAllowedIn(null)).toBe(false)
		expect(cashDiscountAllowedIn(undefined)).toBe(false)
		// A key that is on the object's prototype is not a region.
		expect(cashDiscountAllowedIn('constructor')).toBe(false)
	})

	it('reads a rate only when it is a whole number of basis points in range', () => {
		expect(readCashDiscountBp(300)).toBe(300)
		expect(readCashDiscountBp(CASH_DISCOUNT_MAX_BP)).toBe(CASH_DISCOUNT_MAX_BP)
		for (const bad of [
			0,
			-1,
			1.5,
			CASH_DISCOUNT_MAX_BP + 1,
			Number.NaN,
			'300',
			null,
			undefined,
		]) {
			expect(readCashDiscountBp(bad)).toBeNull()
		}
	})
})

describe('the amount', () => {
	it('is the percentage of what the bill costs after its other discounts, rounded down', () => {
		expect(
			cashDiscountCents({
				subtotalCents: 10_000,
				otherAdjustmentCents: 0,
				percentBp: 300,
			}),
		).toBe(300)
		expect(
			cashDiscountCents({
				subtotalCents: 10_000,
				otherAdjustmentCents: 2_000,
				percentBp: 300,
			}),
		).toBe(240)
		// 3% of 33.33 is 0.9999: never a cent more than the rate says.
		expect(
			cashDiscountCents({
				subtotalCents: 3333,
				otherAdjustmentCents: 0,
				percentBp: 300,
			}),
		).toBe(99)
	})

	it('never goes below nothing, whatever the other discounts came to', () => {
		expect(
			cashDiscountCents({
				subtotalCents: 1000,
				otherAdjustmentCents: 5000,
				percentBp: 300,
			}),
		).toBe(0)
		expect(
			cashDiscountCents({
				subtotalCents: 0,
				otherAdjustmentCents: 0,
				percentBp: 300,
			}),
		).toBe(0)
		expect(
			cashDiscountCents({
				subtotalCents: 1000,
				otherAdjustmentCents: -50,
				percentBp: 300,
			}),
		).toBe(30)
	})

	it('is nothing for a rate that is not a rate', () => {
		for (const percentBp of [0, 1.5, CASH_DISCOUNT_MAX_BP + 1, Number.NaN]) {
			expect(
				cashDiscountCents({
					subtotalCents: 10_000,
					otherAdjustmentCents: 0,
					percentBp,
				}),
			).toBe(0)
		}
	})

	it('has a ceiling the highest rate cannot pass, with a cent of rounding for each line', () => {
		expect(
			cashDiscountCeilingCents({ subtotalCents: 10_000, lineCount: 0 }),
		).toBe(1000)
		expect(
			cashDiscountCeilingCents({ subtotalCents: 10_000, lineCount: 3 }),
		).toBe(1003)
		expect(cashDiscountCeilingCents({ subtotalCents: -5, lineCount: -1 })).toBe(
			0,
		)
	})
})

describe('when it applies', () => {
	const base = { dataRegion: 'us', percentBp: 300, paidAllInCash: true }

	it('applies to a bill paid entirely in cash where it is allowed and set', () => {
		expect(cashDiscountBlock(base)).toBeNull()
	})

	it('says why it does not', () => {
		expect(cashDiscountBlock({ ...base, dataRegion: 'ksa' })).toBe(
			'not_allowed_here',
		)
		expect(cashDiscountBlock({ ...base, percentBp: null })).toBe('not_set')
		expect(cashDiscountBlock({ ...base, paidAllInCash: false })).toBe(
			'not_all_cash',
		)
	})

	it('never stacks with a card surcharge on the same bill (#264)', () => {
		expect(cashDiscountBlock({ ...base, cardSurchargeCents: 1 })).toBe(
			'card_surcharge_present',
		)
		expect(cashDiscountBlock({ ...base, cardSurchargeCents: 0 })).toBeNull()
	})
})

describe('the contract and the reports', () => {
	it('is contract 11+, and the adjustment kind is part of it', () => {
		expect(POS_CONTRACT_VERSION).toBeGreaterThanOrEqual(11)
		const adjustment = {
			id: CASH_DISCOUNT_ADJUSTMENT_ID,
			kind: 'cash_discount',
			label: 'Cash discount (3%)',
			amountCents: 300,
		}
		expect(posAdjustmentSchema.safeParse(adjustment).success).toBe(true)
		expect(
			posAdjustmentSchema.safeParse({ ...adjustment, kind: 'surcharge' })
				.success,
		).toBe(false)
	})

	it('reads a stored setting from before the field, and a bad one, as off', () => {
		expect(DEFAULT_POS_LOCATION_STATION_SETTINGS.cashDiscountBp).toBeNull()
		expect(parsePosLocationStationSettings({}).cashDiscountBp).toBeNull()
		expect(
			parsePosLocationStationSettings({ cashDiscountBp: 300 }).cashDiscountBp,
		).toBe(300)
		for (const bad of [0, 5000, 1.5, 'x']) {
			expect(
				parsePosLocationStationSettings({ cashDiscountBp: bad }).cashDiscountBp,
			).toBeNull()
		}
	})

	it('splits a Station sale into discounts, loyalty and the cash discount, gross unchanged', () => {
		const money = posSaleMoney({
			subtotalCents: 10_000,
			adjustmentCents: 800,
			taxCents: 0,
			tipCents: 0,
			totalCents: 9200,
			taxInclusive: false,
			adjustments: [
				{ kind: 'discount', amountCents: 300 },
				{ kind: 'loyalty', amountCents: 200 },
				{ kind: 'cash_discount', amountCents: 300 },
			],
		})
		expect(money.grossMinor).toBe(10_000)
		expect(money.netMinor).toBe(9200)
		expect(money.discountMinor).toBe(300)
		expect(money.loyaltyMinor).toBe(200)
		expect(money.cashDiscountMinor).toBe(300)
	})

	it('is no cash discount for a sale without one, or an online order', () => {
		expect(
			posSaleMoney({
				subtotalCents: 1000,
				adjustmentCents: 100,
				taxCents: 0,
				tipCents: 0,
				totalCents: 900,
				taxInclusive: false,
				adjustments: [{ kind: 'discount', amountCents: 100 }],
			}).cashDiscountMinor,
		).toBe(0)
		expect(
			restaurantSaleMoney({
				subtotalCents: 1000,
				discountCents: 100,
				loyaltyDiscountCents: 0,
				taxCents: 0,
				tipCents: 0,
				deliveryFeeCents: 0,
				deliveryDiscountCents: 0,
				totalCents: 900,
			}).cashDiscountMinor,
		).toBe(0)
	})

	it('puts the cash discount in the day report as its own figure', () => {
		const summary = posSalesSummary({
			orders: [
				{
					status: 'paid',
					totals: { taxCents: 0, tipCents: 0, totalCents: 9700 },
					subtotalCents: 10_000,
					discountCents: 0,
					cashDiscountCents: 300,
					lineVoids: [],
				},
				{
					status: 'paid',
					totals: { taxCents: 0, tipCents: 0, totalCents: 1000 },
					subtotalCents: 1000,
					discountCents: 0,
					lineVoids: [],
				},
			],
			payments: [],
			refunds: [],
		})
		expect(summary.cashDiscountCents).toBe(300)
		expect(summary.discountCents).toBe(0)
		expect(summary.grossBeforeDiscountsCents).toBe(11_000)
		// A day with none has no such figure.
		expect(
			posSalesSummary({
				orders: [
					{
						status: 'paid',
						totals: { taxCents: 0, tipCents: 0, totalCents: 1000 },
						subtotalCents: 1000,
						discountCents: 0,
						lineVoids: [],
					},
				],
				payments: [],
				refunds: [],
			}).cashDiscountCents,
		).toBeUndefined()
	})
})
