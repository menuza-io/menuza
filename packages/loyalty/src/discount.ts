import {
	cartLineRemainingMinor,
	cartLineTotalMinor,
	type LoyaltyCart,
	type LoyaltyCartLine,
} from './cart.ts'
import {
	allocateProportionally,
	BASIS_POINTS,
	mulDiv,
	sameCurrency,
	sumMinor,
} from './money.ts'
import { type LoyaltyRewardDefinition } from './rewards.ts'

/**
 * What a reward takes off a cart. It applies after discounts and coupons, to
 * what each line has left. Rewards are capped at the eligible
 * merchandise value, percentages round down, and the amount is spread over the
 * eligible lines by largest remainder (ties to the earlier line) so tax
 * allocation, receipts and refunds all see the same split.
 */

export type RewardDiscountLine = {
	lineId: string
	discountMinor: number
	/** Units given away whole by a free-item reward (they earn no item points). */
	rewardUnits: number
}

export type RewardDiscountFailure =
	'currency_mismatch' | 'reward_not_applicable' | 'zero_value'

export type RewardDiscountResult =
	| {
			ok: true
			discountMinor: number
			/** Merchandise value of the eligible lines, before this discount. */
			eligibleMinor: number
			eligibleLineIds: string[]
			lines: RewardDiscountLine[]
			/** The line a free-item reward applies to. */
			targetLineId: string | null
	  }
	| { ok: false; code: RewardDiscountFailure }

export function rewardEligibleLines(
	definition: LoyaltyRewardDefinition,
	lines: readonly LoyaltyCartLine[],
): LoyaltyCartLine[] {
	switch (definition.kind) {
		case 'order':
			return lines.filter((line) => cartLineRemainingMinor(line) > 0)
		case 'categories': {
			const wanted = new Set(definition.categoryIds)
			return lines.filter(
				(line) =>
					cartLineRemainingMinor(line) > 0 &&
					line.categoryIds.some((categoryId) => wanted.has(categoryId)),
			)
		}
		case 'items': {
			const wanted = new Set(definition.itemIds)
			return lines.filter(
				(line) => cartLineRemainingMinor(line) > 0 && wanted.has(line.itemId),
			)
		}
		case 'free_item':
			return lines.filter((line) => line.itemId === definition.itemId)
	}
}

/**
 * What a free-item reward takes off a line: one unit of the variant, but never
 * more than a unit's share of what the line has left after discounts.
 *
 * The cart carries only the line's total discount, not which units it came
 * from, so the share is the line's remainder over its quantity, rounded up.
 * When a discount took whole units (buy one get one on 2 x $10 leaves one $10
 * unit) this under-values the reward ($5 rather than $10): the guest is never
 * given more than the line has left, at the cost of sometimes less. Valuing
 * the dearest unit exactly needs per-unit remainders on the cart line.
 */
function freeItemValue(line: LoyaltyCartLine): number {
	const unitLeft = Math.ceil(cartLineRemainingMinor(line) / line.quantity)
	return Math.min(line.unitBaseMinor, unitLeft)
}

export function computeRewardDiscount(
	reward: { currency: string; definition: LoyaltyRewardDefinition },
	cart: LoyaltyCart,
	options: { targetLineId?: string | null } = {},
): RewardDiscountResult {
	if (!sameCurrency(reward.currency, cart.currency)) {
		return { ok: false, code: 'currency_mismatch' }
	}
	const { definition } = reward
	const eligible = rewardEligibleLines(definition, cart.lines)
	if (eligible.length === 0) return { ok: false, code: 'reward_not_applicable' }
	const eligibleMinor = sumMinor(eligible.map(cartLineRemainingMinor))
	const eligibleLineIds = eligible.map((line) => line.lineId)

	if (definition.kind === 'free_item') {
		let target: LoyaltyCartLine | undefined
		if (options.targetLineId) {
			target = eligible.find((line) => line.lineId === options.targetLineId)
			if (!target) return { ok: false, code: 'reward_not_applicable' }
		} else {
			// The dearest unit left on the bill, first one on a tie.
			for (const line of eligible) {
				if (!target || freeItemValue(line) > freeItemValue(target)) {
					target = line
				}
			}
		}
		const discountMinor = freeItemValue(target!)
		if (discountMinor <= 0) return { ok: false, code: 'zero_value' }
		return {
			ok: true,
			discountMinor,
			eligibleMinor,
			eligibleLineIds,
			lines: [{ lineId: target!.lineId, discountMinor, rewardUnits: 1 }],
			targetLineId: target!.lineId,
		}
	}

	let discountMinor: number
	const { discount } = definition
	if (discount.type === 'fixed') {
		discountMinor = Math.min(discount.amountMinor, eligibleMinor)
	} else {
		discountMinor = mulDiv(eligibleMinor, discount.percentBp, BASIS_POINTS)
		if (discount.maxDiscountMinor !== null) {
			discountMinor = Math.min(discountMinor, discount.maxDiscountMinor)
		}
		discountMinor = Math.min(discountMinor, eligibleMinor)
	}
	if (discountMinor <= 0) return { ok: false, code: 'zero_value' }
	const shares = allocateProportionally(
		discountMinor,
		eligible.map(cartLineRemainingMinor),
	)
	return {
		ok: true,
		discountMinor,
		eligibleMinor,
		eligibleLineIds,
		lines: eligible.map((line, index) => ({
			lineId: line.lineId,
			discountMinor: shares[index]!,
			rewardUnits: 0,
		})),
		targetLineId: null,
	}
}
