import { z } from 'zod'
import { loyaltyCartSchema } from '../cart.ts'
import { LOYALTY_APPROVAL_STATUSES } from '../codes.ts'
import { minorSchema } from '../money.ts'
import { LOYALTY_UNIT_LABELS } from '../program.ts'
import {
	loyaltyBalanceSchema,
	loyaltyPublicRewardSchema,
	loyaltyRewardQuoteSchema,
} from './public.ts'

/**
 * Till contract: `/pos/loyalty/*`, called browser-direct by a paired Station
 * terminal (device secret, and the staff session when sign-in is on).
 *
 * - `identify` turns a customer's member code into a binding the terminal
 *   keeps for offline sales. It never authorizes spending.
 * - Spending needs an approval the customer grants in their signed-in wallet,
 *   or by reading back a one-time code sent to their verified phone. Once
 *   approved the points are bound to that sale before the till records the
 *   discount; the sale upload then consumes or releases them.
 */

const idSchema = z.string().min(1).max(64)
const msSchema = z.number().int().nonnegative()
const bindingSchema = z.string().min(1).max(64)

export const loyaltyPosIdentifyRequestSchema = z
	.object({ code: z.string().min(1).max(32) })
	.strict()

export const loyaltyPosMemberSchema = z
	.object({
		binding: z.string(),
		bindingExpiresAt: msSchema,
		/** First name only, for the cashier to greet. */
		firstName: z.string().nullable(),
		unitLabel: z.enum(LOYALTY_UNIT_LABELS),
		balance: loyaltyBalanceSchema,
	})
	.strict()
export type LoyaltyPosMember = z.infer<typeof loyaltyPosMemberSchema>

export const loyaltyPosIdentifyResponseSchema = z
	.object({
		member: loyaltyPosMemberSchema,
		rewards: z.array(loyaltyPublicRewardSchema),
		redemptionEnabled: z.boolean(),
	})
	.strict()

export const loyaltyPosQuoteRequestSchema = z
	.object({
		binding: bindingSchema,
		rewardId: idSchema,
		cart: loyaltyCartSchema,
		targetLineId: z.string().min(1).max(100).nullable().default(null),
	})
	.strict()

export const loyaltyPosQuoteResponseSchema = z
	.object({
		quote: loyaltyRewardQuoteSchema,
		availableAfter: z.number().int(),
	})
	.strict()

export const loyaltyPosApprovalRequestSchema = z
	.object({
		binding: bindingSchema,
		rewardId: idSchema,
		rewardVersion: z.number().int().min(1),
		/** The till's order id the discount will be recorded on. */
		saleId: z.string().uuid(),
		cart: loyaltyCartSchema,
		targetLineId: z.string().min(1).max(100).nullable().default(null),
	})
	.strict()

export const loyaltyPosApprovalSchema = z
	.object({
		id: idSchema,
		status: z.enum(LOYALTY_APPROVAL_STATUSES),
		saleId: z.string(),
		rewardId: idSchema,
		rewardVersion: z.number().int().min(1),
		rewardName: z.string(),
		pointsCost: z.number().int().min(1),
		discountMinor: minorSchema,
		lines: z.array(
			z
				.object({
					lineId: z.string(),
					discountMinor: minorSchema,
					rewardUnits: z.number().int().nonnegative(),
				})
				.strict(),
		),
		cartHash: z.string(),
		/** Set once approved: record it on the sale's loyalty adjustment. */
		redemptionId: idSchema.nullable(),
		expiresAt: msSchema,
		/** A one-time code can be sent to the member's verified phone. */
		otpAvailable: z.boolean(),
		otpSentAt: msSchema.nullable(),
	})
	.strict()
export type LoyaltyPosApproval = z.infer<typeof loyaltyPosApprovalSchema>

export const loyaltyPosApprovalResponseSchema = z
	.object({ approval: loyaltyPosApprovalSchema })
	.strict()

export const loyaltyPosOtpVerifyRequestSchema = z
	.object({ otp: z.string().min(1).max(12) })
	.strict()
