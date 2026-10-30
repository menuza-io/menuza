import { describe, expect, it } from 'vitest'
import {
	loyaltyCheckoutQuoteResponseSchema,
	loyaltyWalletResponseSchema,
} from './public.ts'

/** The smallest answer `/loyalty/checkout/quote` can give. */
function quoteResponse() {
	return {
		currency: 'USD',
		unitLabel: 'points',
		balance: { points: 150, reserved: 0, available: 150 },
		rewards: [
			{
				rewardId: 'rwd_coffee',
				rewardVersion: 1,
				applicable: true,
				code: null,
				discountMinor: 500,
				pointsCost: 100,
				affordable: true,
				eligibleLineIds: [],
				lines: [],
				targetLineId: null,
			},
		],
		totals: {
			subtotalMinor: 2000,
			discountMinor: 0,
			taxMinor: 165,
			taxInclusive: false,
			tipMinor: 0,
			deliveryFeeMinor: 0,
			totalMinor: 2165,
		},
		selectedRewardId: null,
		availableAfter: 150,
	}
}

describe('public contract tolerance', () => {
	it('parses a quote that carries fields a deployed client predates', () => {
		const future = {
			...quoteResponse(),
			newTopLevelField: { anything: true },
			rewards: [
				{
					...quoteResponse().rewards[0],
					applicable: false,
					// A refusal code added after this client shipped.
					code: 'some_future_reason',
					newRowField: 'x',
					lines: [{ lineId: 'l1', discountMinor: 0, rewardUnits: 0, extra: 1 }],
				},
			],
			totals: { ...quoteResponse().totals, futureFeeMinor: 25 },
		}
		const parsed = loyaltyCheckoutQuoteResponseSchema.safeParse(future)
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.rewards[0]?.code).toBe('some_future_reason')
			expect(parsed.data).not.toHaveProperty('newTopLevelField')
		}
	})

	it('parses a wallet with fields a deployed client predates', () => {
		const parsed = loyaltyWalletResponseSchema.safeParse({
			wallet: null,
			futureField: [1, 2, 3],
		})
		expect(parsed.success).toBe(true)
	})
})
