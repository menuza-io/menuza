import { describe, expect, it } from 'vitest'
import {
	estimateRewardReturn,
	LOYALTY_HIGH_RETURN_WARNING_BP,
} from './estimate.ts'
import { LOYALTY_MAX_MINOR } from './money.ts'

describe('estimateRewardReturn', () => {
	it('computes effective return for spend rules and triggers high-return warnings above 20%', () => {
		// 1 point per $1 (100 minor); 100 pts -> $5 off (500 minor) = 5%
		const fivePct = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			reward: {
				kind: 'order',
				pointsCost: 100,
				discount: { type: 'fixed', amountMinor: 500 },
			},
		})
		expect(fivePct).toEqual({
			status: 'ok',
			effectiveReturnBp: 500,
			effectiveReturnPercent: 5,
			spendToEarnMinor: 10_000,
			rewardValueMinor: 500,
			exceedsWarning: false,
		})

		// Exact threshold (20%) does not warn; lowering pointsCost pushes >20% and warns immediately
		const exact20 = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			reward: {
				kind: 'order',
				pointsCost: 100,
				discount: { type: 'fixed', amountMinor: 2000 },
			},
		})
		expect(exact20).toMatchObject({
			status: 'ok',
			effectiveReturnBp: LOYALTY_HIGH_RETURN_WARNING_BP,
			exceedsWarning: false,
		})

		const over20 = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			reward: {
				kind: 'order',
				pointsCost: 80,
				discount: { type: 'fixed', amountMinor: 2000 },
			},
		})
		expect(over20).toMatchObject({
			status: 'ok',
			effectiveReturnBp: 2500,
			effectiveReturnPercent: 25,
			exceedsWarning: true,
		})
	})

	it('incorporates tier multipliers and requests missing average order or item price when required', () => {
		// 2x tier doubles effective percent-back
		const goldRate = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			reward: {
				kind: 'order',
				pointsCost: 100,
				discount: { type: 'fixed', amountMinor: 500 },
			},
			tierMultiplierBp: 20_000,
		})
		expect(goldRate).toMatchObject({
			status: 'ok',
			effectiveReturnBp: 1000,
			spendToEarnMinor: 5000,
		})

		expect(
			estimateRewardReturn({
				earning: { method: 'visit', points: 10 },
				reward: {
					kind: 'order',
					pointsCost: 100,
					discount: { type: 'fixed', amountMinor: 500 },
				},
			}),
		).toEqual({ status: 'needs_input', missing: 'average_order' })

		// Free item needs itemPriceMinor
		expect(
			estimateRewardReturn({
				earning: { method: 'spend', points: 1, perMinor: 100 },
				reward: { kind: 'free_item', pointsCost: 100 },
			}),
		).toEqual({ status: 'needs_input', missing: 'item_price' })

		const freeBurger = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			reward: { kind: 'free_item', pointsCost: 100 },
			itemPriceMinor: 800,
		})
		expect(freeBurger).toMatchObject({
			status: 'ok',
			effectiveReturnBp: 800,
			effectiveReturnPercent: 8,
			rewardValueMinor: 800,
		})
	})

	it('uses BigInt safely up to LOYALTY_MAX_MINOR and reflects every point cost change smoothly', () => {
		const a = estimateRewardReturn({
			earning: { method: 'visit', points: 10 },
			reward: {
				kind: 'order',
				pointsCost: 50,
				discount: { type: 'fixed', amountMinor: 500 },
			},
			averageOrderMinor: 2500,
		})
		const b = estimateRewardReturn({
			earning: { method: 'visit', points: 10 },
			reward: {
				kind: 'order',
				pointsCost: 51,
				discount: { type: 'fixed', amountMinor: 500 },
			},
			averageOrderMinor: 2500,
		})
		expect(a.status).toBe('ok')
		expect(b.status).toBe('ok')
		if (a.status === 'ok' && b.status === 'ok') {
			expect(a.effectiveReturnBp).toBeGreaterThan(b.effectiveReturnBp)
		}

		const huge = estimateRewardReturn({
			earning: { method: 'spend', points: 1, perMinor: 100_000_000 },
			reward: {
				kind: 'order',
				pointsCost: 10_000,
				discount: { type: 'fixed', amountMinor: LOYALTY_MAX_MINOR },
			},
		})
		expect(huge.status).toBe('ok')
	})
})
