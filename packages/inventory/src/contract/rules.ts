import { type StockStatus } from './items.ts'

/**
 * Pure rules both the region and the App rely on, so a badge on screen and a
 * figure in the API can never disagree.
 */

/** Out at or below zero; low below "order more when below" (when set). */
export function stockStatus(
	onHand: number,
	orderBelowQuantity: number | null,
): StockStatus {
	if (onHand <= 0) return 'out'
	if (orderBelowQuantity !== null && onHand < orderBelowQuantity) return 'low'
	return 'ok'
}

/** A difference needs a look when it is over 20% of expected … */
export const REVIEW_DIFFERENCE_SHARE_BP = 2000
/** … and worth more than 25 major units (when the cost is known). */
export const REVIEW_DIFFERENCE_MIN_MINOR = 2500

/**
 * Whether a counted line needs review. Without a known cost, the share rule
 * alone decides. An expected quantity of zero with something counted is
 * always a big difference.
 */
export function needsReview(input: {
	expected: number
	counted: number
	differenceValueMinor: number | null
}): boolean {
	const difference = Math.abs(input.counted - input.expected)
	if (difference === 0) return false
	const base = Math.abs(input.expected)
	const overShare =
		base === 0 || difference * 10_000 > base * REVIEW_DIFFERENCE_SHARE_BP
	if (!overShare) return false
	if (input.differenceValueMinor === null) return true
	return Math.abs(input.differenceValueMinor) > REVIEW_DIFFERENCE_MIN_MINOR
}

/**
 * Food cost in basis points for a period: (opening + purchases − closing) /
 * sales. `null` when there were no sales. Never negative (a count that found
 * more than expected can push usage below zero; that reads as 0%).
 */
export function foodCostBp(input: {
	openingMinor: number
	purchasesMinor: number
	closingMinor: number
	salesMinor: number
}): number | null {
	if (input.salesMinor <= 0) return null
	const used = input.openingMinor + input.purchasesMinor - input.closingMinor
	if (used <= 0) return 0
	return Math.round((used * 10_000) / input.salesMinor)
}

/** Price change between two costs, in basis points (null without a previous cost). */
export function priceChangeBp(
	previousCostMicro: number | null,
	newCostMicro: number,
): number | null {
	if (previousCostMicro === null || previousCostMicro <= 0) return null
	return Math.round(
		((newCostMicro - previousCostMicro) * 10_000) / previousCostMicro,
	)
}

/** A rise worth a "needs attention" row. */
export const PRICE_RISE_ALERT_BP = 500
