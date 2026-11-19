import { BASIS_POINTS, LOYALTY_MULTIPLIER_ONE_BP, mulDiv } from './money.ts'
import { type LoyaltyEarningRule } from './program.ts'
import { type LoyaltyDiscount, type LoyaltyRewardKind } from './rewards.ts'

/** 20% effective return threshold above which the UI warns operators. */
export const LOYALTY_HIGH_RETURN_WARNING_BP = 2000

export type EstimateRewardReturnInput = {
	earning: LoyaltyEarningRule
	reward: {
		kind: LoyaltyRewardKind
		pointsCost: number
		discount?: LoyaltyDiscount | null
	}
	averageOrderMinor?: number | null
	itemPriceMinor?: number | null
	tierMultiplierBp?: number | null
}

export type EstimateRewardReturnResult =
	| {
			status: 'ok'
			/** Basis points (e.g. 500 = 5.00%). Capped only by safe integer bounds. */
			effectiveReturnBp: number
			/** Rounded to 1 decimal place (e.g. 5.5 for 5.5%). */
			effectiveReturnPercent: number
			spendToEarnMinor: number
			rewardValueMinor: number
			exceedsWarning: boolean
	  }
	| {
			status: 'needs_input'
			missing: 'average_order' | 'item_price'
	  }

function roundDivBigInt(num: bigint, den: bigint): number {
	if (den <= 0n || num <= 0n) return 0
	const rounded = (num + den / 2n) / den
	return rounded > BigInt(Number.MAX_SAFE_INTEGER)
		? Number.MAX_SAFE_INTEGER
		: Number(rounded)
}

function ceilDivBigInt(num: bigint, den: bigint): number {
	if (den <= 0n || num <= 0n) return 0
	const q = (num + den - 1n) / den
	return q > BigInt(Number.MAX_SAFE_INTEGER)
		? Number.MAX_SAFE_INTEGER
		: Number(q)
}

/**
 * Computes the effective percentage-back of a reward under the active earning
 * rule (and optional tier multiplier). Uses BigInt ratios to stay exact up to
 * `LOYALTY_MAX_MINOR`.
 */
export function estimateRewardReturn(
	input: EstimateRewardReturnInput,
): EstimateRewardReturnResult {
	const { earning, reward } = input
	const pointsCost = Math.max(1, Math.floor(reward.pointsCost))
	const multiplierBp = Math.max(
		LOYALTY_MULTIPLIER_ONE_BP,
		Math.floor(input.tierMultiplierBp ?? LOYALTY_MULTIPLIER_ONE_BP),
	)

	// 1. Determine the monetary reward value in minor units.
	let rewardValueMinor: number
	if (reward.kind === 'free_item') {
		if (!input.itemPriceMinor || input.itemPriceMinor <= 0) {
			return { status: 'needs_input', missing: 'item_price' }
		}
		rewardValueMinor = Math.floor(input.itemPriceMinor)
	} else if (!reward.discount) {
		return { status: 'needs_input', missing: 'item_price' }
	} else if (reward.discount.type === 'fixed') {
		rewardValueMinor = reward.discount.amountMinor
	} else {
		const sampleMinor =
			reward.kind === 'order'
				? input.averageOrderMinor
				: (input.itemPriceMinor ?? input.averageOrderMinor)
		if (!sampleMinor || sampleMinor <= 0) {
			return {
				status: 'needs_input',
				missing: reward.kind === 'order' ? 'average_order' : 'item_price',
			}
		}
		const pctMinor = mulDiv(
			Math.floor(sampleMinor),
			reward.discount.percentBp,
			BASIS_POINTS,
			'floor',
		)
		rewardValueMinor =
			reward.discount.maxDiscountMinor !== null
				? Math.min(pctMinor, reward.discount.maxDiscountMinor)
				: pctMinor
	}

	// 2. Determine customer spend required to accumulate `pointsCost`.
	let spendNum: bigint
	let spendDen: bigint
	if (earning.method === 'spend') {
		// spendToEarn = pointsCost * perMinor * 10_000 / (earning.points * multiplierBp)
		spendNum =
			BigInt(pointsCost) *
			BigInt(earning.perMinor) *
			BigInt(LOYALTY_MULTIPLIER_ONE_BP)
		spendDen = BigInt(earning.points) * BigInt(multiplierBp)
	} else if (earning.method === 'visit') {
		if (!input.averageOrderMinor || input.averageOrderMinor <= 0) {
			return { status: 'needs_input', missing: 'average_order' }
		}
		spendNum =
			BigInt(pointsCost) *
			BigInt(Math.floor(input.averageOrderMinor)) *
			BigInt(LOYALTY_MULTIPLIER_ONE_BP)
		spendDen = BigInt(earning.points) * BigInt(multiplierBp)
	} else {
		const unitPrice = input.itemPriceMinor ?? input.averageOrderMinor
		if (!unitPrice || unitPrice <= 0) {
			return { status: 'needs_input', missing: 'item_price' }
		}
		spendNum =
			BigInt(pointsCost) *
			BigInt(Math.floor(unitPrice)) *
			BigInt(LOYALTY_MULTIPLIER_ONE_BP)
		spendDen = BigInt(earning.points) * BigInt(multiplierBp)
	}

	const spendToEarnMinor = Math.max(1, ceilDivBigInt(spendNum, spendDen))
	// effectiveReturnBp = rewardValueMinor * 10_000 / (spendNum / spendDen)
	//                   = rewardValueMinor * 10_000 * spendDen / spendNum
	const effectiveReturnBp = roundDivBigInt(
		BigInt(rewardValueMinor) * BigInt(BASIS_POINTS) * spendDen,
		spendNum,
	)
	const effectiveReturnPercent = Math.round(effectiveReturnBp / 10) / 10

	return {
		status: 'ok',
		effectiveReturnBp,
		effectiveReturnPercent,
		spendToEarnMinor,
		rewardValueMinor,
		exceedsWarning: effectiveReturnBp > LOYALTY_HIGH_RETURN_WARNING_BP,
	}
}
