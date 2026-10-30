import { describe, expect, it } from 'vitest'
import {
	DISCOUNT_EXAMPLES,
	EARNING_EXAMPLES,
	REFUND_EXAMPLES,
} from './acceptance-examples.ts'
import { loyaltyCartSchema } from './cart.ts'
import { computeRewardDiscount } from './discount.ts'
import {
	computeEarning,
	computeRefundReversal,
	loyaltyPurchaseSnapshotSchema,
} from './earning.ts'
import { loyaltyEarningRuleSchema } from './program.ts'
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
