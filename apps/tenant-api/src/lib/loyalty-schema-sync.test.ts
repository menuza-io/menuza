import { orderLoyaltySelectionSchema } from '@repo/common/restaurant-orders'
import {
	LOYALTY_ACTOR_KINDS,
	LOYALTY_ADJUSTMENT_REASONS,
	LOYALTY_APPROVAL_METHODS,
	LOYALTY_APPROVAL_STATUSES,
	LOYALTY_CHANNELS,
	LOYALTY_EARNING_METHODS,
	LOYALTY_LEDGER_TYPES,
	LOYALTY_MEMBER_STATUSES,
	LOYALTY_OUTBOX_STATUSES,
	LOYALTY_PROGRAM_STATUSES,
	LOYALTY_PURCHASE_SOURCES,
	LOYALTY_PURCHASE_STATES,
	LOYALTY_REDEMPTION_STATES,
	LOYALTY_REWARD_KINDS,
	LOYALTY_REWARD_STATUSES,
	loyaltyOrderRewardSchema,
} from '@repo/loyalty'
import {
	LOYALTY_ACTOR_KIND_VALUES,
	LOYALTY_ADJUSTMENT_REASON_VALUES,
	LOYALTY_APPROVAL_METHOD_VALUES,
	LOYALTY_APPROVAL_STATUS_VALUES,
	LOYALTY_CHANNEL_VALUES,
	LOYALTY_EARNING_METHOD_VALUES,
	LOYALTY_LEDGER_TYPE_VALUES,
	LOYALTY_MEMBER_STATUS_VALUES,
	LOYALTY_OUTBOX_STATUS_VALUES,
	LOYALTY_PROGRAM_STATUS_VALUES,
	LOYALTY_PURCHASE_STATE_VALUES,
	LOYALTY_REDEMPTION_STATE_VALUES,
	LOYALTY_REWARD_KIND_VALUES,
	LOYALTY_REWARD_STATUS_VALUES,
	LOYALTY_SOURCE_TYPE_VALUES,
} from '@repo/tenant-db'
import { describe, expect, it } from 'vitest'

/**
 * The tenant-db check constraints name these values in SQL; the domain lists
 * live in @repo/loyalty. They must be the same sets, so a new state or reason
 * is added in both places (and a migration) or neither.
 */
const PAIRS: Array<[string, readonly string[], readonly string[]]> = [
	['program status', LOYALTY_PROGRAM_STATUS_VALUES, LOYALTY_PROGRAM_STATUSES],
	['earning method', LOYALTY_EARNING_METHOD_VALUES, LOYALTY_EARNING_METHODS],
	['reward kind', LOYALTY_REWARD_KIND_VALUES, LOYALTY_REWARD_KINDS],
	['reward status', LOYALTY_REWARD_STATUS_VALUES, LOYALTY_REWARD_STATUSES],
	['member status', LOYALTY_MEMBER_STATUS_VALUES, LOYALTY_MEMBER_STATUSES],
	['ledger type', LOYALTY_LEDGER_TYPE_VALUES, LOYALTY_LEDGER_TYPES],
	[
		'adjustment reason',
		LOYALTY_ADJUSTMENT_REASON_VALUES,
		LOYALTY_ADJUSTMENT_REASONS,
	],
	['actor kind', LOYALTY_ACTOR_KIND_VALUES, LOYALTY_ACTOR_KINDS],
	['channel', LOYALTY_CHANNEL_VALUES, LOYALTY_CHANNELS],
	['purchase source', LOYALTY_SOURCE_TYPE_VALUES, LOYALTY_PURCHASE_SOURCES],
	['purchase state', LOYALTY_PURCHASE_STATE_VALUES, LOYALTY_PURCHASE_STATES],
	[
		'redemption state',
		LOYALTY_REDEMPTION_STATE_VALUES,
		LOYALTY_REDEMPTION_STATES,
	],
	[
		'approval status',
		LOYALTY_APPROVAL_STATUS_VALUES,
		LOYALTY_APPROVAL_STATUSES,
	],
	['approval method', LOYALTY_APPROVAL_METHOD_VALUES, LOYALTY_APPROVAL_METHODS],
	['outbox status', LOYALTY_OUTBOX_STATUS_VALUES, LOYALTY_OUTBOX_STATUSES],
]

describe('loyalty schema enums stay in step with @repo/loyalty', () => {
	it.each(PAIRS)('%s', (_label, schemaValues, domainValues) => {
		expect([...schemaValues].sort()).toEqual([...domainValues].sort())
	})
})

/**
 * The placement/tab `loyalty` field lives in `@repo/common`
 * (`orderLoyaltySelectionSchema`) because the loyalty package cannot be
 * imported there; `loyaltyOrderRewardSchema` is the loyalty copy. The two
 * must accept and produce the same shapes.
 */
describe('orderLoyaltySelectionSchema mirrors loyaltyOrderRewardSchema', () => {
	const valid = {
		rewardId: 'reward_1',
		rewardVersion: 3,
		expectedDiscountMinor: 500,
		targetLineId: '4',
	}

	it('parses a valid selection identically', () => {
		expect(orderLoyaltySelectionSchema.parse(valid)).toEqual(
			loyaltyOrderRewardSchema.parse(valid),
		)
	})

	it('applies the same targetLineId default', () => {
		const { targetLineId: ignoredTarget, ...rest } = valid
		void ignoredTarget
		expect(orderLoyaltySelectionSchema.parse(rest)).toEqual(
			loyaltyOrderRewardSchema.parse(rest),
		)
	})

	it('both reject an extra key', () => {
		const extra = { ...valid, sneaky: true }
		expect(orderLoyaltySelectionSchema.safeParse(extra).success).toBe(false)
		expect(loyaltyOrderRewardSchema.safeParse(extra).success).toBe(false)
	})

	it('both reject a bad version', () => {
		const bad = { ...valid, rewardVersion: 0 }
		expect(orderLoyaltySelectionSchema.safeParse(bad).success).toBe(false)
		expect(loyaltyOrderRewardSchema.safeParse(bad).success).toBe(false)
	})

	// Each bound is the same on both sides: the last accepted value passes in
	// both schemas and the first refused one fails in both.
	const BOUNDS: Array<[string, Record<string, unknown>, boolean]> = [
		['rewardId of 64 characters', { rewardId: 'r'.repeat(64) }, true],
		['rewardId of 65 characters', { rewardId: 'r'.repeat(65) }, false],
		['rewardVersion 1_000_000', { rewardVersion: 1_000_000 }, true],
		['rewardVersion 1_000_001', { rewardVersion: 1_000_001 }, false],
		['expectedDiscountMinor 1e12', { expectedDiscountMinor: 1e12 }, true],
		[
			'expectedDiscountMinor 1e12 + 1',
			{ expectedDiscountMinor: 1e12 + 1 },
			false,
		],
		['expectedDiscountMinor -1', { expectedDiscountMinor: -1 }, false],
		['expectedDiscountMinor 1.5', { expectedDiscountMinor: 1.5 }, false],
		['targetLineId of 100 characters', { targetLineId: 't'.repeat(100) }, true],
		[
			'targetLineId of 101 characters',
			{ targetLineId: 't'.repeat(101) },
			false,
		],
	]

	it.each(BOUNDS)('both agree on %s', (_label, change, accepted) => {
		const input = { ...valid, ...change }
		const common = orderLoyaltySelectionSchema.safeParse(input)
		const domain = loyaltyOrderRewardSchema.safeParse(input)
		expect(common.success).toBe(accepted)
		expect(domain.success).toBe(accepted)
		if (accepted) expect(common.data).toEqual(domain.data)
	})
})
