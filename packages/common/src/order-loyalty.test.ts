import { describe, expect, it } from 'vitest'
import { orderLoyaltySelectionSchema } from './order-loyalty.ts'

/**
 * `loyaltyOrderRewardSchema` in `@repo/loyalty` has the same cases
 * (packages/loyalty/src/bounds.test.ts); keep the two tables equal.
 */
describe('orderLoyaltySelectionSchema bounds', () => {
	const valid = {
		rewardId: 'r'.repeat(64),
		rewardVersion: 1_000_000,
		expectedDiscountMinor: 1_000_000_000_000,
		targetLineId: 'l'.repeat(100),
	}
	const accepts = (value: unknown) =>
		orderLoyaltySelectionSchema.safeParse(value).success

	it('accepts the largest allowed values', () => {
		expect(accepts(valid)).toBe(true)
	})

	it('defaults the target line to null', () => {
		const { targetLineId: ignoredTarget, ...rest } = valid
		void ignoredTarget
		expect(orderLoyaltySelectionSchema.parse(rest).targetLineId).toBeNull()
	})

	it.each([
		['rewardId', { rewardId: 'r'.repeat(65) }],
		['rewardId', { rewardId: '' }],
		['rewardVersion', { rewardVersion: 1_000_001 }],
		['rewardVersion', { rewardVersion: 0 }],
		['expectedDiscountMinor', { expectedDiscountMinor: 1_000_000_000_001 }],
		['expectedDiscountMinor', { expectedDiscountMinor: -1 }],
		['expectedDiscountMinor', { expectedDiscountMinor: 1.5 }],
		['targetLineId', { targetLineId: 'l'.repeat(101) }],
		['targetLineId', { targetLineId: '' }],
	])('refuses a bad %s', (_field, patch) => {
		expect(accepts({ ...valid, ...patch })).toBe(false)
	})

	it('refuses an extra key', () => {
		expect(accepts({ ...valid, extra: true })).toBe(false)
	})
})
