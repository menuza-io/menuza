import {
	type LoyaltyPublicProgram,
	type LoyaltyPublicReward,
	type LoyaltyWallet,
} from '@repo/loyalty'
import { progressPercent } from './format'
import { type LoyaltyClientErrorCode } from './loyalty-client'

/**
 * Pure decisions behind the rewards wallet: which screen to show and what
 * the member can do on it. The server enforces every rule again; this only
 * keeps the app from offering actions it would refuse.
 */

export type LoyaltyMemberWallet = LoyaltyWallet & {
	member: NonNullable<LoyaltyWallet['member']>
	balance: NonNullable<LoyaltyWallet['balance']>
}

export type WalletScreen =
	{ kind: 'unavailable' } | { kind: 'member'; wallet: LoyaltyMemberWallet }

/**
 * The customer is the member: the wallet read opens the points account, so a
 * wallet without one only means the program is unavailable or the account was
 * erased. Both show nothing.
 */
export function walletScreen(wallet: LoyaltyWallet | null): WalletScreen {
	if (!wallet?.member) return { kind: 'unavailable' }
	return {
		kind: 'member',
		wallet: {
			...wallet,
			member: wallet.member,
			balance: wallet.balance ?? { points: 0, reserved: 0, available: 0 },
		},
	}
}

/** Load failures that mean "no program on this site", not "try again". */
export function isUnavailableCode(code: LoyaltyClientErrorCode): boolean {
	return (
		code === 'loyalty_disabled' ||
		code === 'program_not_found' ||
		code === 'organization_not_found'
	)
}

export type MemberAbilities = {
	/** The program is paused: nothing new can be earned or spent. */
	paused: boolean
	/** The business put the account on hold. */
	suspended: boolean
	/** A refund left the member owing points. */
	owes: boolean
	canShowCode: boolean
	canApprove: boolean
}

export function memberAbilities(wallet: LoyaltyMemberWallet): MemberAbilities {
	const active = wallet.member.status === 'active'
	const running = wallet.program.status === 'active'
	return {
		paused: !running,
		suspended: !active,
		owes: wallet.balance.available < 0,
		canShowCode: active && running,
		canApprove: active && running && wallet.program.redemptionEnabled,
	}
}

export type NextRewardView =
	| {
			kind: 'next'
			reward: LoyaltyPublicReward
			pointsNeeded: number
			/** 0–100 */
			percent: number
	  }
	| { kind: 'all-unlocked' }
	| null

/** Progress toward the cheapest reward the member cannot afford yet. */
export function nextRewardView(wallet: LoyaltyMemberWallet): NextRewardView {
	const rewards = wallet.program.rewards
	if (rewards.length === 0) return null
	const next = wallet.nextReward
	if (!next) return { kind: 'all-unlocked' }
	const reward = rewards.find((candidate) => candidate.id === next.rewardId)
	if (!reward) return null
	return {
		kind: 'next',
		reward,
		pointsNeeded: next.pointsNeeded,
		percent: progressPercent(wallet.balance.available, reward.pointsCost),
	}
}

export function rewardStanding(
	reward: Pick<LoyaltyPublicReward, 'pointsCost'>,
	available: number,
): { affordable: boolean; pointsNeeded: number } {
	const needed = reward.pointsCost - available
	return needed <= 0
		? { affordable: true, pointsNeeded: 0 }
		: { affordable: false, pointsNeeded: needed }
}

export type RewardView = {
	reward: LoyaltyPublicReward
	affordable: boolean
	pointsNeeded: number
}

/** Each reward of the program with whether the member can afford it, in program order. */
export function rewardViews(
	program: LoyaltyPublicProgram,
	available: number,
): RewardView[] {
	return program.rewards.map((reward) => ({
		reward,
		...rewardStanding(reward, available),
	}))
}

/**
 * When to stop offering a till request on this device. The answer carries
 * only the server's `expiresAt`; a device clock that runs slow is capped at
 * one TTL from arrival, and one that runs fast (the request already looks
 * past) gets no countdown at all, leaving the next poll to decide.
 */
export function approvalDeadline(
	expiresAt: number,
	receivedAt: number,
	ttlMs: number,
): number | null {
	const remaining = expiresAt - receivedAt
	if (!Number.isFinite(remaining) || remaining <= 0) return null
	return receivedAt + Math.min(remaining, ttlMs)
}
