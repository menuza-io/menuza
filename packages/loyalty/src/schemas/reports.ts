import { addDays, daysBetween } from '@repo/zoned-time'
import { z } from 'zod'
import { currencySchema, minorSchema } from '../money.ts'

/**
 * Program figures for a reporting window of local calendar days in the
 * program's time zone (both ends included, at most 366 days).
 *
 * Definitions (also in docs/loyalty.md):
 * - accounts: customers with a points account (opened automatically when a
 *   verified customer signs in); accountsOpened counts those opened in the window;
 * - active customer: at least one earning purchase in the window;
 * - repeat-purchase rate: active customers with two or more such purchases;
 * - purchase frequency: purchases per active customer;
 * - customer revenue: what those customers paid for those purchases, net of refunds;
 * - redemption conversion: active customers who used a reward in the window;
 * - discount cost: discounts on rewards used in the window, net of rewards
 *   restored by a full refund.
 *
 * These describe customers with accounts. A difference between them and others is
 * not uplift caused by the program; measuring that needs a holdout.
 */

/** A real calendar day: `2026-13-45` and `2026-02-30` do not pass. */
export const loyaltyReportDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => addDays(value, 0) === value, 'Not a calendar date')
const dateSchema = loyaltyReportDateSchema

export const LOYALTY_REPORT_MAX_DAYS = 366

export const loyaltyReportQuerySchema = z
	.object({ from: dateSchema, to: dateSchema })
	.strict()
	.refine((window) => window.from <= window.to, {
		message: 'from must not be after to',
		path: ['from'],
	})
	.refine(
		(window) => daysBetween(window.from, window.to) < LOYALTY_REPORT_MAX_DAYS,
		{ message: 'The window is too long', path: ['to'] },
	)
export type LoyaltyReportQuery = z.infer<typeof loyaltyReportQuerySchema>

const count = z.number().int().nonnegative()
/** A ratio in basis points (10000 = 100%). */
const ratioBp = z.number().int().nonnegative()

export const loyaltyReportSchema = z
	.object({
		window: z
			.object({ from: dateSchema, to: dateSchema, timeZone: z.string() })
			.strict(),
		currency: currencySchema,
		customers: z
			.object({
				accountsTotal: count,
				accountsOpened: count,
				activeInWindow: count,
			})
			.strict(),
		points: z
			.object({
				earned: count,
				reversed: count,
				redeemed: count,
				restored: count,
				adjustedNet: z.number().int(),
				reservedNow: count,
				outstandingNow: z.number().int(),
			})
			.strict(),
		redemptions: z
			.object({
				consumed: count,
				restored: count,
				released: count,
				discountCostMinor: z.number().int(),
				conversionBp: ratioBp,
			})
			.strict(),
		purchases: z
			.object({
				count,
				customerRevenueMinor: minorSchema,
				averageOrderValueMinor: minorSchema,
				repeatPurchaseRateBp: ratioBp,
				/** Purchases per active customer, in hundredths (250 = 2.5). */
				frequencyHundredths: count,
			})
			.strict(),
		operations: z
			.object({
				redemptionsInReview: count,
				purchasesInReview: count,
				openRedemptions: count,
				oldestOpenRedemptionAgeMs: z.number().int().nonnegative().nullable(),
				refundsRecorded: count,
			})
			.strict(),
	})
	.strict()
export type LoyaltyReport = z.infer<typeof loyaltyReportSchema>

export function ratioToBp(numerator: number, denominator: number): number {
	if (denominator <= 0) return 0
	return Math.floor((numerator * 10_000) / denominator)
}
