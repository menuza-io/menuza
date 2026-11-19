import { describe, expect, it } from 'vitest'
import {
	DISCOUNT_EXAMPLES,
	EARNING_EXAMPLES,
	ESTIMATE_EXAMPLES,
	EXPIRY_EXAMPLES,
	PROMOTION_EXAMPLES,
	REFUND_EXAMPLES,
	TIER_EARNING_EXAMPLES,
	TIER_REFUND_EXAMPLES,
} from './acceptance-examples.ts'
import { loyaltyCartSchema } from './cart.ts'
import { computeRewardDiscount } from './discount.ts'
import {
	applyTierToEarning,
	computeEarning,
	computeRefundReversal,
	loyaltyPurchaseSnapshotSchema,
} from './earning.ts'
import { estimateRewardReturn } from './estimate.ts'
import { computePointExpiry } from './expiry.ts'
import { loyaltyEarningRuleSchema } from './program.ts'
import { computePromotionBonus, loyaltyPromotionSchema } from './promotions.ts'
import { loyaltyRewardDefinitionSchema } from './rewards.ts'

describe('acceptance examples: earning', () => {
	for (const example of EARNING_EXAMPLES) {
		it(example.id, () => {
			const rule = loyaltyEarningRuleSchema.parse(example.earning)
			const snapshot = loyaltyPurchaseSnapshotSchema.parse(example.snapshot)
			const result = computeEarning(
				{ rule, minimumSpendMinor: example.minimumSpendMinor, snapshot },
				{ visitAlreadyAwarded: example.visitAlreadyAwarded },
			)
			expect(result.points).toBe(example.expectedPoints)
			expect(result.reason).toBe(example.expectedReason)
		})
	}
})

describe('acceptance examples: rewards', () => {
	for (const example of DISCOUNT_EXAMPLES) {
		it(example.id, () => {
			const definition = loyaltyRewardDefinitionSchema.parse(example.reward)
			const cart = loyaltyCartSchema.parse(example.cart)
			const result = computeRewardDiscount(
				{ currency: 'USD', definition },
				cart,
				{ targetLineId: example.targetLineId },
			)
			if (example.expected.ok) {
				expect(result.ok).toBe(true)
				if (!result.ok) return
				expect(result.discountMinor).toBe(example.expected.discountMinor)
				const byLine = Object.fromEntries(
					result.lines
						.filter((line) => line.discountMinor > 0)
						.map((line) => [line.lineId, line.discountMinor]),
				)
				expect(byLine).toEqual(example.expected.lines)
			} else {
				expect(result).toEqual({ ok: false, code: example.expected.code })
			}
		})
	}
})

describe('acceptance examples: refunds', () => {
	for (const example of REFUND_EXAMPLES) {
		it(example.id, () => {
			const rule = loyaltyEarningRuleSchema.parse(example.earning)
			const snapshot = loyaltyPurchaseSnapshotSchema.parse(example.snapshot)
			const earned = computeEarning({
				rule,
				minimumSpendMinor: example.minimumSpendMinor,
				snapshot,
			})
			expect(earned.points).toBe(example.awardedPoints)
			let reversed = 0
			for (const step of example.steps) {
				const result = computeRefundReversal({
					rule,
					minimumSpendMinor: example.minimumSpendMinor,
					snapshot,
					awardedPoints: example.awardedPoints,
					previouslyReversedPoints: reversed,
					cumulativeRefundedMinor: step.cumulativeRefundedMinor,
				})
				expect(result.reversePoints).toBe(step.reversePoints)
				expect(result.fullRefund).toBe(step.fullRefund)
				reversed += result.reversePoints
			}
		})
	}
})

describe('acceptance examples: promotions', () => {
	for (const example of PROMOTION_EXAMPLES) {
		it(example.id, () => {
			const rule = loyaltyEarningRuleSchema.parse(example.earning)
			const snapshot = loyaltyPurchaseSnapshotSchema.parse(example.snapshot)
			const earning = computeEarning(
				{ rule, minimumSpendMinor: example.minimumSpendMinor, snapshot },
				{ visitAlreadyAwarded: example.visitAlreadyAwarded },
			)
			expect(earning.points).toBe(example.expectedBasePoints)
			const bonus = computePromotionBonus({
				promotions: example.promotions.map((promotion) =>
					loyaltyPromotionSchema.parse(promotion),
				),
				stacking: example.stacking ?? 'best',
				earning,
				snapshot,
				occurredAt: example.occurredAt,
				timeZone: example.timeZone,
				locationId: example.locationId,
			})
			expect(bonus.points).toBe(example.expectedBonusPoints)
			expect(bonus.applied.map(({ id, points }) => ({ id, points }))).toEqual(
				example.expectedApplied,
			)
		})
	}
})

describe('acceptance examples: tiers', () => {
	for (const example of TIER_EARNING_EXAMPLES) {
		it(example.id, () => {
			const rule = loyaltyEarningRuleSchema.parse(example.earning)
			const snapshot = loyaltyPurchaseSnapshotSchema.parse(example.snapshot)
			const base = computeEarning({
				rule,
				minimumSpendMinor: example.minimumSpendMinor,
				snapshot,
			})
			const tiered = applyTierToEarning(base, example.tierMultiplierBp)
			expect(tiered.points).toBe(example.expectedTierPoints)
			const bonus = computePromotionBonus({
				promotions: example.promotions.map((p) =>
					loyaltyPromotionSchema.parse(p),
				),
				stacking: example.stacking ?? 'best',
				earning: tiered,
				snapshot,
				occurredAt: example.occurredAt,
				timeZone: example.timeZone,
				locationId: example.locationId,
			})
			expect(bonus.points).toBe(example.expectedPromoBonus)
			expect(tiered.points + bonus.points).toBe(example.expectedTotalPoints)
		})
	}

	for (const example of TIER_REFUND_EXAMPLES) {
		it(example.id, () => {
			const rule = loyaltyEarningRuleSchema.parse(example.earning)
			const snapshot = loyaltyPurchaseSnapshotSchema.parse(example.snapshot)
			const result = computeRefundReversal({
				rule,
				minimumSpendMinor: example.minimumSpendMinor,
				snapshot,
				tierMultiplierBp: example.tierMultiplierBp,
				awardedPoints: example.awardedPoints,
				previouslyReversedPoints: 0,
				cumulativeRefundedMinor: example.cumulativeRefundedMinor,
			})
			expect(result.reversePoints).toBe(example.expectedReversePoints)
		})
	}
})

describe('acceptance examples: expiry', () => {
	for (const example of EXPIRY_EXAMPLES) {
		it(example.id, () => {
			const res = computePointExpiry(example.input)
			expect(res.expiredDue).toBe(example.expectedExpiredDue)
			expect(res.nextExpiryAt).toBe(example.expectedNextExpiryAt)
			expect(res.nextExpiryPoints).toBe(example.expectedNextExpiryPoints)
		})
	}
})

describe('acceptance examples: estimate', () => {
	for (const example of ESTIMATE_EXAMPLES) {
		it(example.id, () => {
			const res = estimateRewardReturn(example.input)
			expect(res.status).toBe('ok')
			if (res.status === 'ok') {
				expect(res.effectiveReturnBp).toBe(example.expectedReturnBp)
				expect(res.exceedsWarning).toBe(example.expectedExceedsWarning)
			}
		})
	}
})
