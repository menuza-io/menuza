import { describe, expect, it } from 'vitest'
import { loyaltyReportSchema } from './reports.ts'

const { promotions: ignoredPromotions, ...OLD_REGION_PAYLOAD } = {
	window: { from: '2025-01-01', to: '2025-01-30', timeZone: 'Asia/Riyadh' },
	currency: 'SAR',
	customers: { accountsTotal: 42, accountsOpened: 5, activeInWindow: 12 },
	points: {
		earned: 900,
		reversed: 0,
		redeemed: 300,
		restored: 0,
		adjustedNet: 0,
		reservedNow: 0,
		outstandingNow: 600,
	},
	redemptions: {
		consumed: 3,
		restored: 0,
		released: 0,
		discountCostMinor: 1500,
		conversionBp: 2500,
	},
	promotions: { bonusPoints: 10, byPromotion: [] },
	purchases: {
		count: 20,
		customerRevenueMinor: 100_000,
		averageOrderValueMinor: 5000,
		repeatPurchaseRateBp: 5000,
		frequencyHundredths: 166,
	},
	operations: {
		redemptionsInReview: 1,
		purchasesInReview: 0,
		openRedemptions: 0,
		oldestOpenRedemptionAgeMs: null,
		refundsRecorded: 0,
	},
}

describe('loyaltyReportSchema version skew', () => {
	it('parses a report from a region that predates promotions', () => {
		const parsed = loyaltyReportSchema.parse(OLD_REGION_PAYLOAD)
		expect(parsed.promotions).toEqual({ bonusPoints: 0, byPromotion: [] })
	})

	it('keeps promotions when the region sends them', () => {
		const parsed = loyaltyReportSchema.parse({
			...OLD_REGION_PAYLOAD,
			promotions: { bonusPoints: 10, byPromotion: [] },
		})
		expect(parsed.promotions.bonusPoints).toBe(10)
	})
})
