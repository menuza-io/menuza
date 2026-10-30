import { LOYALTY_APPROVAL_TTL_MS } from '@repo/loyalty'
import {
	approvalDeadline,
	isUnavailableCode,
	memberAbilities,
	nextRewardView,
	rewardStanding,
	rewardViews,
	walletScreen,
	type LoyaltyMemberWallet,
} from './wallet-view'
import {
	testErasedWallet,
	testProgram,
	testWallet,
} from '@/test/loyalty/fixtures'

function member(wallet = testWallet()): LoyaltyMemberWallet {
	const screen = walletScreen(wallet)
	if (screen.kind !== 'member') throw new Error('Expected a member wallet')
	return screen.wallet
}

describe('walletScreen', () => {
	it('is unavailable while loyalty is off for the site', () => {
		expect(walletScreen(null)).toEqual({ kind: 'unavailable' })
	})

	it('is unavailable when the account was erased, never a join screen', () => {
		expect(walletScreen(testErasedWallet())).toEqual({ kind: 'unavailable' })
	})

	it('treats a member without a balance row as holding nothing', () => {
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
		// wallet-member: 332 available, the 400-point reward next (68 needed).
		const view = nextRewardView(member())
		expect(view).toMatchObject({ kind: 'next', pointsNeeded: 68, percent: 83 })
	})

	it('rounds progress with integer math', () => {
		const program = testProgram()
		const reward = program.rewards[0]
		if (!reward || reward.pointsCost !== 100)
			throw new Error('unexpected fixture')
		const view = nextRewardView(
			member(
				testWallet({
					balance: { points: 57, reserved: 0, available: 57 },
					nextReward: { rewardId: reward.id, pointsNeeded: 43 },
				}),
			),
		)
		// 57 / 100 * 100 is 56.99… in floating point; the website showed 56%.
		expect(view).toMatchObject({ kind: 'next', percent: 57 })
	})

	it('says every reward is unlocked when none is out of reach', () => {
		expect(nextRewardView(member(testWallet({ nextReward: null })))).toEqual({
			kind: 'all-unlocked',
		})
	})

	it('shows nothing without rewards or for a reward the app does not know', () => {
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

	it('marks each reward of the program', () => {
		const program = testProgram()
		const views = rewardViews(program, 120)
		expect(views.map((view) => view.affordable)).toEqual([true, false, false])
		expect(views.map((view) => view.reward.id)).toEqual(
			program.rewards.map((reward) => reward.id),
		)
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
