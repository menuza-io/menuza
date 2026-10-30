import {
	LOYALTY_APPROVAL_TTL_MS,
	loyaltyCheckoutQuoteResponseSchema,
	loyaltyCustomerApprovalSchema,
	loyaltyHistoryEntrySchema,
	loyaltyPublicProgramSchema,
	loyaltyPublicRewardSchema,
	loyaltyWalletSchema,
	type LoyaltyCheckoutQuote,
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
	type LoyaltyPublicReward,
	type LoyaltyRewardQuote,
	type LoyaltyWallet,
} from '@repo/loyalty'

/** Region answers for tests. Each builder parses its result with the contract schema. */

export function testReward(
	overrides: Partial<LoyaltyPublicReward> = {},
): LoyaltyPublicReward {
	return loyaltyPublicRewardSchema.parse({
		id: 'rwd_coffee',
		version: 1,
		name: 'Free coffee',
		description: null,
		pointsCost: 100,
		kind: 'order',
		discount: { type: 'fixed', amountMinor: 500 },
		itemIds: [],
		categoryIds: [],
		freeItemId: null,
		labels: { items: {}, categories: {} },
		currency: 'USD',
		...overrides,
	})
}

export function testProgram(
	overrides: Partial<LoyaltyPublicProgram> = {},
): LoyaltyPublicProgram {
	return loyaltyPublicProgramSchema.parse({
		name: 'Acme Rewards',
		unitLabel: 'points',
		currency: 'USD',
		status: 'active',
		earning: { method: 'spend', points: 1, perMinor: 100 },
		minimumSpendMinor: 0,
		labels: { items: {}, categories: {} },
		terms: 'Points have no cash value.\nRewards cannot be exchanged.',
		rewards: [
			testReward(),
			testReward({
				id: 'rwd_big',
				name: '$20 off',
				pointsCost: 400,
				discount: { type: 'fixed', amountMinor: 2000 },
			}),
		],
		redemptionEnabled: true,
		...overrides,
	})
}

type MemberOverrides = Partial<NonNullable<LoyaltyWallet['member']>>

export function testWallet(
	overrides: Partial<Omit<LoyaltyWallet, 'member'>> & {
		member?: MemberOverrides | null
	} = {},
): LoyaltyWallet {
	const { member, ...rest } = overrides
	return loyaltyWalletSchema.parse({
		program: testProgram(),
		member:
			member === null
				? null
				: {
						id: 'mem_1',
						status: 'active',
						...member,
					},
		balance: { points: 150, reserved: 0, available: 150 },
		nextReward: { rewardId: 'rwd_big', pointsNeeded: 250 },
		pendingApprovals: 0,
		...rest,
	})
}

export function testApproval(
	overrides: Partial<LoyaltyCustomerApproval> = {},
): LoyaltyCustomerApproval {
	const createdAt = overrides.createdAt ?? Date.now()
	return loyaltyCustomerApprovalSchema.parse({
		id: 'apr_1',
		status: 'pending',
		rewardName: 'Free coffee',
		pointsCost: 100,
		discountMinor: 500,
		currency: 'USD',
		createdAt,
		expiresAt: createdAt + LOYALTY_APPROVAL_TTL_MS,
		...overrides,
	})
}

export function testRewardQuote(
	overrides: Partial<LoyaltyRewardQuote> = {},
): LoyaltyRewardQuote {
	return {
		rewardId: 'rwd_coffee',
		rewardVersion: 1,
		applicable: true,
		code: null,
		discountMinor: 500,
		pointsCost: 100,
		affordable: true,
		eligibleLineIds: ['line_1'],
		lines: [{ lineId: 'line_1', discountMinor: 500, rewardUnits: 1 }],
		targetLineId: null,
		...overrides,
	}
}

export function testQuote(
	overrides: Partial<LoyaltyCheckoutQuote> = {},
): LoyaltyCheckoutQuote {
	return loyaltyCheckoutQuoteResponseSchema.parse({
		currency: 'USD',
		unitLabel: 'points',
		balance: { points: 150, reserved: 0, available: 150 },
		rewards: [testRewardQuote()],
		totals: {
			subtotalMinor: 2_000,
			discountMinor: 0,
			taxMinor: 165,
			taxInclusive: false,
			tipMinor: 0,
			deliveryFeeMinor: 0,
			totalMinor: 2_165,
		},
		selectedRewardId: null,
		availableAfter: 150,
		...overrides,
	})
}

export function testEntry(
	overrides: Partial<LoyaltyHistoryEntry> = {},
): LoyaltyHistoryEntry {
	return loyaltyHistoryEntrySchema.parse({
		id: 'led_1',
		at: Date.UTC(2030, 4, 1, 12),
		type: 'earn',
		delta: 12,
		channel: 'pos',
		rewardName: null,
		reason: null,
		...overrides,
	})
}
