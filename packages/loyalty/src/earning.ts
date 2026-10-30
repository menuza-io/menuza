import { businessDateOf } from '@repo/zoned-time'
import { z } from 'zod'
import {
	allocateProportionally,
	currencySchema,
	LOYALTY_MAX_POINTS,
	minorSchema,
	mulDiv,
	sumMinor,
} from './money.ts'
import { loyaltyCatalogIdSchema, type LoyaltyEarningRule } from './program.ts'

/**
 * Earning and refund reversal. Both read only the purchase snapshot and the
 * program version it was earned under, never today's rules.
 */

/**
 * Most lines a purchase snapshot holds. A QR tab is one purchase made of any
 * number of rounds of up to 50 lines each, and nothing limits the rounds a tab
 * can collect (only the per-table hourly rate), so `buildPurchaseSnapshot`
 * merges lines of the same item once a purchase would pass this bound. The
 * merged count is then the tab's distinct items, far below it.
 */
export const LOYALTY_MAX_PURCHASE_LINES = 2000
/** Largest quantity on one snapshot line; merged tab lines add up. */
export const LOYALTY_MAX_PURCHASE_LINE_QUANTITY = 1_000_000

export const loyaltyPurchaseLineSchema = z
	.object({
		lineId: z.string().min(1).max(100),
		itemId: loyaltyCatalogIdSchema,
		categoryIds: z.array(loyaltyCatalogIdSchema).max(50),
		quantity: z.number().int().min(1).max(LOYALTY_MAX_PURCHASE_LINE_QUANTITY),
		/** Merchandise value of the line after discounts, excluding tax. */
		netMinor: minorSchema,
		/** Units a free-item reward gave away; they earn no item or category points. */
		rewardUnits: z
			.number()
			.int()
			.min(0)
			.max(LOYALTY_MAX_PURCHASE_LINE_QUANTITY)
			.default(0),
	})
	.strict()
	.refine((line) => line.rewardUnits <= line.quantity, {
		message: 'More reward units than units',
		path: ['rewardUnits'],
	})
export type LoyaltyPurchaseLine = z.infer<typeof loyaltyPurchaseLineSchema>

export const loyaltyPurchaseSnapshotSchema = z
	.object({
		currency: currencySchema,
		/** Everything the customer paid for the purchase: merchandise, tax, tip and fees. */
		totalPaidMinor: minorSchema,
		lines: z.array(loyaltyPurchaseLineSchema).max(LOYALTY_MAX_PURCHASE_LINES),
	})
	.strict()
export type LoyaltyPurchaseSnapshot = z.infer<
	typeof loyaltyPurchaseSnapshotSchema
>

export type EarningSkipReason =
	'below_minimum' | 'visit_already_awarded' | 'nothing_eligible'

export type EarningResult = {
	points: number
	/** Merchandise after discounts, excluding tax, tips and fees. */
	eligibleMinor: number
	reason: EarningSkipReason | null
	lines: Array<{ lineId: string; units: number; points: number }>
}

export function purchaseEligibleMinor(
	snapshot: Pick<LoyaltyPurchaseSnapshot, 'lines'>,
): number {
	return sumMinor(snapshot.lines.map((line) => line.netMinor))
}

/** Units of a line that earn item or category points. */
export function earningUnits(line: LoyaltyPurchaseLine): number {
	if (line.netMinor <= 0) return 0
	return Math.max(0, line.quantity - line.rewardUnits)
}

function lineMatches(rule: LoyaltyEarningRule, line: LoyaltyPurchaseLine) {
	if (rule.method === 'items') return rule.itemIds.includes(line.itemId)
	if (rule.method === 'categories') {
		return line.categoryIds.some((id) => rule.categoryIds.includes(id))
	}
	return false
}

export function computeEarning(
	input: {
		rule: LoyaltyEarningRule
		minimumSpendMinor: number
		snapshot: Pick<LoyaltyPurchaseSnapshot, 'lines'>
	},
	options: { visitAlreadyAwarded?: boolean } = {},
): EarningResult {
	const { rule, minimumSpendMinor, snapshot } = input
	const eligibleMinor = purchaseEligibleMinor(snapshot)
	const empty = (reason: EarningSkipReason): EarningResult => ({
		points: 0,
		eligibleMinor,
		reason,
		lines: [],
	})
	if (eligibleMinor <= 0) return empty('nothing_eligible')
	if (eligibleMinor < minimumSpendMinor) return empty('below_minimum')

	switch (rule.method) {
		case 'spend': {
			// One ledger entry cannot hold more than LOYALTY_MAX_POINTS. A rule
			// the schema allows can still outrun it on a very large sale (spend
			// amounts reach LOYALTY_MAX_MINOR, a spend unit only
			// LOYALTY_MAX_SPEND_PER_MINOR), so the award is capped instead of
			// becoming an entry that can only fail.
			const points = Math.min(
				mulDiv(eligibleMinor, rule.points, rule.perMinor),
				LOYALTY_MAX_POINTS,
			)
			if (points <= 0) return empty('below_minimum')
			const shares = allocateProportionally(
				points,
				snapshot.lines.map((line) => line.netMinor),
			)
			return {
				points,
				eligibleMinor,
				reason: null,
				lines: snapshot.lines.map((line, index) => ({
					lineId: line.lineId,
					units: line.quantity,
					points: shares[index]!,
				})),
			}
		}
		case 'visit': {
			if (options.visitAlreadyAwarded) return empty('visit_already_awarded')
			return { points: rule.points, eligibleMinor, reason: null, lines: [] }
		}
		case 'items':
		case 'categories': {
			const lines = snapshot.lines
				.filter((line) => lineMatches(rule, line))
				.map((line) => {
					const units = earningUnits(line)
					return { lineId: line.lineId, units, points: units * rule.points }
				})
				.filter((line) => line.points > 0)
			const raw = sumMinor(lines.map((line) => line.points))
			if (raw <= 0) return empty('nothing_eligible')
			// As above: items and categories rules can add up to more than one
			// entry holds (points per unit times units over many lines), so the
			// purchase earns at most LOYALTY_MAX_POINTS, spread over the same
			// lines in the same proportions.
			const points = Math.min(raw, LOYALTY_MAX_POINTS)
			if (points === raw) return { points, eligibleMinor, reason: null, lines }
			const shares = allocateProportionally(
				points,
				lines.map((line) => line.points),
			)
			return {
				points,
				eligibleMinor,
				reason: null,
				lines: lines.map((line, index) => ({
					...line,
					points: shares[index]!,
				})),
			}
		}
	}
}

/** The organization-local calendar day a purchase counts for (visit awards). */
export function visitDateOf(occurredAt: number, timeZone: string): string {
	return businessDateOf(occurredAt, timeZone)
}

export type RefundReversal = {
	/** Merchandise the cumulative refund covers, rounded up. */
	refundedEligibleMinor: number
	remainingEligibleMinor: number
	/** Points the purchase keeps after every refund so far. */
	pointsAfter: number
	/** Points to take back now (never negative). */
	reversePoints: number
	/** Every cent paid has come back. */
	fullRefund: boolean
	/** How the refunded merchandise splits over the lines (largest remainder). */
	lines: Array<{ lineId: string; refundedMinor: number }>
}

/**
 * Points a purchase keeps after refunds. An amount-only refund is spread over
 * the purchase in proportion to what was paid, so its merchandise share is
 * `eligible * refunded / paid`, rounded up. Cumulative: each refund event
 * recomputes from the total refunded so far and takes back only the
 * difference, so repeated, partial and out-of-order events are idempotent.
 *
 * - spend: points on the remaining merchandise, rounded down;
 * - items and categories: the award in proportion to the remaining merchandise,
 *   rounded down;
 * - visit: kept while the remainder still qualifies;
 * - any method: nothing once the remainder falls below the minimum spend.
 */
export function computeRefundReversal(input: {
	rule: LoyaltyEarningRule
	minimumSpendMinor: number
	snapshot: LoyaltyPurchaseSnapshot
	awardedPoints: number
	previouslyReversedPoints: number
	cumulativeRefundedMinor: number
}): RefundReversal {
	const { rule, snapshot } = input
	const eligibleMinor = purchaseEligibleMinor(snapshot)
	const paid = snapshot.totalPaidMinor
	const refunded = Math.max(0, Math.min(paid, input.cumulativeRefundedMinor))
	const fullRefund = paid > 0 && refunded >= paid
	const refundedEligibleMinor =
		paid <= 0
			? 0
			: fullRefund
				? eligibleMinor
				: Math.min(eligibleMinor, mulDiv(eligibleMinor, refunded, paid, 'ceil'))
	const remainingEligibleMinor = eligibleMinor - refundedEligibleMinor
	const awarded = Math.max(0, input.awardedPoints)

	let pointsAfter: number
	if (
		awarded === 0 ||
		remainingEligibleMinor <= 0 ||
		remainingEligibleMinor < input.minimumSpendMinor
	) {
		pointsAfter = 0
	} else if (rule.method === 'spend') {
		pointsAfter = Math.min(
			awarded,
			mulDiv(remainingEligibleMinor, rule.points, rule.perMinor),
		)
	} else if (rule.method === 'visit') {
		pointsAfter = awarded
	} else {
		pointsAfter = mulDiv(awarded, remainingEligibleMinor, eligibleMinor)
	}
	const reversePoints = Math.max(
		0,
		awarded - pointsAfter - Math.max(0, input.previouslyReversedPoints),
	)
	const shares = allocateProportionally(
		refundedEligibleMinor,
		snapshot.lines.map((line) => line.netMinor),
	)
	return {
		refundedEligibleMinor,
		remainingEligibleMinor,
		pointsAfter,
		reversePoints,
		fullRefund,
		lines: snapshot.lines.map((line, index) => ({
			lineId: line.lineId,
			refundedMinor: shares[index]!,
		})),
	}
}
