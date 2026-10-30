import {
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
 * What a reward takes off a cart. Discounts are capped at the eligible
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
	| 'currency_mismatch'
	| 'stacking_not_allowed'
	| 'reward_not_applicable'
	| 'zero_value'

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
			return lines.filter((line) => cartLineTotalMinor(line) > 0)
		case 'categories': {
			const wanted = new Set(definition.categoryIds)
			return lines.filter(
				(line) =>
					cartLineTotalMinor(line) > 0 &&
					line.categoryIds.some((categoryId) => wanted.has(categoryId)),
			)
		}
		case 'items': {
			const wanted = new Set(definition.itemIds)
			return lines.filter(
				(line) => cartLineTotalMinor(line) > 0 && wanted.has(line.itemId),
			)
		}
		case 'free_item':
			return lines.filter((line) => line.itemId === definition.itemId)
	}
}

export function computeRewardDiscount(
	reward: { currency: string; definition: LoyaltyRewardDefinition },
	cart: LoyaltyCart,
	options: { targetLineId?: string | null } = {},
): RewardDiscountResult {
	if (!sameCurrency(reward.currency, cart.currency)) {
		return { ok: false, code: 'currency_mismatch' }
	}
	if (cart.otherDiscountMinor > 0) {
		return { ok: false, code: 'stacking_not_allowed' }
	}
	const { definition } = reward
	const eligible = rewardEligibleLines(definition, cart.lines)
	if (eligible.length === 0) return { ok: false, code: 'reward_not_applicable' }
	const eligibleMinor = sumMinor(eligible.map(cartLineTotalMinor))
	const eligibleLineIds = eligible.map((line) => line.lineId)

	if (definition.kind === 'free_item') {
		let target: LoyaltyCartLine | undefined
		if (options.targetLineId) {
			target = eligible.find((line) => line.lineId === options.targetLineId)
			if (!target) return { ok: false, code: 'reward_not_applicable' }
		} else {
			// The dearest variant on the bill, first one on a tie.
			for (const line of eligible) {
				if (!target || line.unitBaseMinor > target.unitBaseMinor) target = line
			}
		}
		const discountMinor = target!.unitBaseMinor
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
		eligible.map(cartLineTotalMinor),
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

/**
 * Order totals with a discount taken off before tax, the way the till already
 * prices adjustments: the taxable base shrinks in proportion to the subtotal,
 * inclusive tax is reported rather than added, and a percentage tip applies to
 * the discounted subtotal.
 */
export function totalsWithDiscount(input: {
	subtotalMinor: number
	taxableMinor: number
	taxRatePercent: number
	taxInclusive: boolean
	discountMinor: number
	tipPercent?: number
	tipMinor?: number
	feesMinor?: number
}): {
	subtotalMinor: number
	discountMinor: number
	taxMinor: number
	tipMinor: number
	feesMinor: number
	totalMinor: number
} {
	const subtotal = input.subtotalMinor
	const discount = Math.max(0, Math.min(subtotal, input.discountMinor))
	const taxBase =
		subtotal > 0
			? Math.round(input.taxableMinor * (1 - discount / subtotal))
			: 0
	const rate = Math.max(0, Math.min(100, input.taxRatePercent || 0))
	const taxMinor = input.taxInclusive
		? Math.round((taxBase * rate) / (100 + rate))
		: Math.round((taxBase * rate) / 100)
	const tipMinor =
		input.tipMinor ??
		Math.round(((subtotal - discount) * (input.tipPercent ?? 0)) / 100)
	const feesMinor = input.feesMinor ?? 0
	return {
		subtotalMinor: subtotal,
		discountMinor: discount,
		taxMinor,
		tipMinor,
		feesMinor,
		totalMinor:
			subtotal -
			discount +
			(input.taxInclusive ? 0 : taxMinor) +
			tipMinor +
			feesMinor,
	}
}
