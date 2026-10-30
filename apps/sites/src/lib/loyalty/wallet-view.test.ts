import { LOYALTY_APPROVAL_TTL_MS } from '@repo/loyalty'
import { describe, expect, it } from 'vitest'
import { testProgram, testWallet } from './test-fixtures.ts'
import {
	approvalDeadline,
	isUnavailableCode,
	memberAbilities,
	nextRewardView,
	rewardStanding,
	walletScreen,
	type LoyaltyMemberWallet,
} from './wallet-view.ts'

function member(wallet = testWallet()): LoyaltyMemberWallet {
	const screen = walletScreen(wallet)
	if (screen.kind !== 'member') throw new Error('Expected a member wallet')
	return screen.wallet
}

describe('walletScreen', () => {
	it('is unavailable while loyalty is off for the site', () => {
		expect(walletScreen(null)).toEqual({ kind: 'unavailable' })
	})

	it('is unavailable for an erased account, which has no points account', () => {
		expect(walletScreen(testWallet({ member: null, balance: null }))).toEqual({
			kind: 'unavailable',
		})
	})

	it('treats an account without a balance row as holding nothing', () => {
		expect(member(testWallet({ balance: null })).balance).toEqual({
			points: 0,
			reserved: 0,
			available: 0,
		})
	})
})

describe('memberAbilities', () => {
	it('lets an active member of a running program show a code and approve', () => {
		expect(memberAbilities(member())).toEqual({
			paused: false,
			suspended: false,
			owes: false,
			canShowCode: true,
			canApprove: true,
		})
	})

	it('allows nothing new while the program is paused', () => {
		expect(
			memberAbilities(
				member(testWallet({ program: testProgram({ status: 'paused' }) })),
			),
		).toMatchObject({ paused: true, canShowCode: false, canApprove: false })
	})

	it('keeps the member code but not approvals while rewards cannot be used', () => {
		expect(
			memberAbilities(
				member(
					testWallet({ program: testProgram({ redemptionEnabled: false }) }),
				),
			),
		).toMatchObject({ canShowCode: true, canApprove: false })
	})

	it('holds a suspended account', () => {
		expect(
			memberAbilities(member(testWallet({ member: { status: 'suspended' } }))),
		).toMatchObject({
			suspended: true,
			canShowCode: false,
			canApprove: false,
		})
	})

	it('flags points owed after a refund', () => {
		expect(
			memberAbilities(
				member(
					testWallet({ balance: { points: -20, reserved: 0, available: -20 } }),
				),
			).owes,
		).toBe(true)
	})
})

describe('nextRewardView', () => {
	it('shows progress toward the next reward', () => {
		const view = nextRewardView(member())
		expect(view).toMatchObject({ kind: 'next', pointsNeeded: 250, percent: 37 })
		expect(view?.kind === 'next' ? view.reward.id : null).toBe('rwd_big')
	})

	it('says every reward is unlocked when none is out of reach', () => {
		expect(nextRewardView(member(testWallet({ nextReward: null })))).toEqual({
			kind: 'all-unlocked',
		})
	})

	it('shows nothing without rewards or for a reward the page does not know', () => {
		expect(
			nextRewardView(
				member(
					testWallet({
						program: testProgram({ rewards: [] }),
						nextReward: null,
					}),
				),
			),
		).toBeNull()
		expect(
			nextRewardView(
				member(
					testWallet({ nextReward: { rewardId: 'rwd_gone', pointsNeeded: 5 } }),
				),
			),
		).toBeNull()
	})
})

describe('rewardStanding', () => {
	it('says whether a reward is affordable and how much is missing', () => {
		expect(rewardStanding({ pointsCost: 100 }, 150)).toEqual({
			affordable: true,
			pointsNeeded: 0,
		})
		expect(rewardStanding({ pointsCost: 100 }, 100)).toEqual({
			affordable: true,
			pointsNeeded: 0,
		})
		expect(rewardStanding({ pointsCost: 400 }, 150)).toEqual({
			affordable: false,
			pointsNeeded: 250,
		})
		expect(rewardStanding({ pointsCost: 100 }, -20)).toEqual({
			affordable: false,
			pointsNeeded: 120,
		})
	})
})

describe('approvalDeadline', () => {
	const ttl = LOYALTY_APPROVAL_TTL_MS

	it('follows the server when the clocks agree', () => {
		expect(approvalDeadline(1_000 + 60_000, 1_000, ttl)).toBe(61_000)
	})

	it('never runs longer than one TTL on a slow device clock', () => {
		expect(approvalDeadline(1_000 + ttl * 4, 1_000, ttl)).toBe(1_000 + ttl)
	})

	it('shows no countdown when the device clock is ahead', () => {
		expect(approvalDeadline(900, 1_000, ttl)).toBeNull()
		expect(approvalDeadline(Number.NaN, 1_000, ttl)).toBeNull()
	})
})

describe('isUnavailableCode', () => {
	it('separates "no program here" from failures worth retrying', () => {
		for (const code of [
			'loyalty_disabled',
			'program_not_found',
			'organization_not_found',
		] as const) {
			expect(isUnavailableCode(code)).toBe(true)
		}
		for (const code of [
			'network',
			'loyalty_unavailable',
			'rate_limited',
			'signed_out',
		] as const) {
			expect(isUnavailableCode(code)).toBe(false)
		}
	})
})
