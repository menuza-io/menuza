import { z } from 'zod'
import {
	LOYALTY_ACTOR_KINDS,
	LOYALTY_ADJUSTMENT_REASONS,
	LOYALTY_CHANNELS,
	LOYALTY_LEDGER_TYPES,
} from '../ledger.ts'
import { currencySchema, minorSchema, positiveMinorSchema } from '../money.ts'
import {
	LOYALTY_EARNING_METHODS,
	LOYALTY_PROGRAM_STATUSES,
	loyaltyProgramConfigSchema,
} from '../program.ts'
import {
	LOYALTY_REDEMPTION_STATES,
	LOYALTY_REVIEW_REASONS,
} from '../redemption.ts'
import {
	LOYALTY_EXCLUDED_REASONS,
	LOYALTY_MEMBER_STATUSES,
	LOYALTY_PURCHASE_SOURCES,
	LOYALTY_PURCHASE_STATES,
	LOYALTY_SKIP_REASONS,
} from '../purchases.ts'
import {
	LOYALTY_REWARD_STATUSES,
	loyaltyRewardDefinitionSchema,
} from '../rewards.ts'
import { loyaltyBalanceSchema } from './public.ts'

/**
 * Operator contract: `/operator/loyalty/*`, called from the App in the
 * operator's browser with a short-lived `lty+jwt`. Configuration changes send
 * `expectedVersion` and get `409 stale_version` when someone saved first.
 */

const idSchema = z.string().min(1).max(64)
const msSchema = z.number().int().nonnegative()
const expectedVersionSchema = z.number().int().min(1)

export const loyaltyProgramVersionSchema = z
	.object({
		id: idSchema,
		version: z.number().int().min(1),
		status: z.enum(LOYALTY_PROGRAM_STATUSES),
		effectiveAt: msSchema,
		config: loyaltyProgramConfigSchema,
		createdAt: msSchema,
		createdBy: z.string().nullable(),
	})
	.strict()

export const loyaltyOperatorProgramSchema = z
	.object({
		id: idSchema,
		status: z.enum(LOYALTY_PROGRAM_STATUSES),
		/** Optimistic concurrency version of the program row. */
		version: z.number().int().min(1),
		/** Once the program has been active its currency cannot change. */
		currencyLocked: z.boolean(),
		current: loyaltyProgramVersionSchema,
		history: z.array(
			z
				.object({
					version: z.number().int().min(1),
					status: z.enum(LOYALTY_PROGRAM_STATUSES),
					method: z.enum(LOYALTY_EARNING_METHODS),
					effectiveAt: msSchema,
					createdBy: z.string().nullable(),
				})
				.strict(),
		),
	})
	.strict()
export type LoyaltyOperatorProgram = z.infer<
	typeof loyaltyOperatorProgramSchema
>

export const loyaltyOperatorProgramResponseSchema = z
	.object({ program: loyaltyOperatorProgramSchema.nullable() })
	.strict()

export const loyaltySaveProgramRequestSchema = z
	.object({
		/** Null only when no program exists yet. */
		expectedVersion: expectedVersionSchema.nullable(),
		config: loyaltyProgramConfigSchema,
	})
	.strict()

export const loyaltyProgramStatusRequestSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		status: z.enum(['active', 'paused']),
	})
	.strict()

export const loyaltyOperatorRewardSchema = z
	.object({
		id: idSchema,
		status: z.enum(LOYALTY_REWARD_STATUSES),
		version: z.number().int().min(1),
		currency: currencySchema,
		definition: loyaltyRewardDefinitionSchema,
		createdAt: msSchema,
		updatedAt: msSchema,
	})
	.strict()
export type LoyaltyOperatorReward = z.infer<typeof loyaltyOperatorRewardSchema>

export const loyaltyRewardsResponseSchema = z
	.object({ rewards: z.array(loyaltyOperatorRewardSchema) })
	.strict()
export const loyaltyRewardResponseSchema = z
	.object({ reward: loyaltyOperatorRewardSchema })
	.strict()

export const loyaltyCreateRewardRequestSchema = z
	.object({ definition: loyaltyRewardDefinitionSchema })
	.strict()
export const loyaltyUpdateRewardRequestSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		definition: loyaltyRewardDefinitionSchema,
	})
	.strict()
export const loyaltyRewardStatusRequestSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		status: z.enum(LOYALTY_REWARD_STATUSES),
	})
	.strict()

/** The balance an operator sees: the wallet's figures plus the lifetime totals. */
export const loyaltyOperatorBalanceSchema = loyaltyBalanceSchema.extend({
	lifetimeEarned: z.number().int().nonnegative(),
	lifetimeRedeemed: z.number().int().nonnegative(),
})
export type LoyaltyOperatorBalance = z.infer<
	typeof loyaltyOperatorBalanceSchema
>

export const loyaltyMemberSummarySchema = z
	.object({
		id: idSchema,
		customerId: idSchema.nullable(),
		name: z.string().nullable(),
		/** Last four digits only; the full number stays on the customer record. */
		phoneLast4: z.string().nullable(),
		status: z.enum(LOYALTY_MEMBER_STATUSES),
		/** The day the points account was opened. */
		createdAt: msSchema,
		balance: loyaltyOperatorBalanceSchema,
		lastPurchaseAt: msSchema.nullable(),
	})
	.strict()
export type LoyaltyMemberSummary = z.infer<typeof loyaltyMemberSummarySchema>

export const loyaltyOperatorLedgerEntrySchema = z
	.object({
		id: idSchema,
		at: msSchema,
		memberId: idSchema,
		/** The customer the account belongs to; null once erased. */
		customerId: idSchema.nullable(),
		type: z.enum(LOYALTY_LEDGER_TYPES),
		delta: z.number().int(),
		channel: z.enum(LOYALTY_CHANNELS).nullable(),
		locationId: z.string().nullable(),
		purchaseId: idSchema.nullable(),
		redemptionId: idSchema.nullable(),
		reason: z.enum(LOYALTY_ADJUSTMENT_REASONS).nullable(),
		note: z.string().nullable(),
		actorKind: z.enum(LOYALTY_ACTOR_KINDS),
		actorId: z.string().nullable(),
	})
	.strict()
export type LoyaltyOperatorLedgerEntry = z.infer<
	typeof loyaltyOperatorLedgerEntrySchema
>

export const loyaltyOperatorPurchaseSchema = z
	.object({
		id: idSchema,
		memberId: idSchema,
		channel: z.enum(LOYALTY_CHANNELS),
		sourceType: z.enum(LOYALTY_PURCHASE_SOURCES),
		sourceId: z.string(),
		locationId: z.string().nullable(),
		currency: currencySchema,
		/** When the sale finished; null while it is still open. */
		occurredAt: msSchema.nullable(),
		state: z.enum(LOYALTY_PURCHASE_STATES),
		reviewReason: z.enum(LOYALTY_REVIEW_REASONS).nullable(),
		excludedReason: z.enum(LOYALTY_EXCLUDED_REASONS).nullable(),
		skipReason: z.enum(LOYALTY_SKIP_REASONS).nullable(),
		programVersion: z.number().int().nullable(),
		eligibleMinor: minorSchema,
		totalPaidMinor: minorSchema,
		awardedPoints: z.number().int().nonnegative(),
		reversedPoints: z.number().int().nonnegative(),
		refundedMinor: minorSchema,
	})
	.strict()
export type LoyaltyOperatorPurchase = z.infer<
	typeof loyaltyOperatorPurchaseSchema
>

export const loyaltyOperatorRedemptionSchema = z
	.object({
		id: idSchema,
		memberId: idSchema,
		rewardId: idSchema,
		rewardVersion: z.number().int().min(1),
		rewardName: z.string(),
		points: z.number().int().min(1),
		state: z.enum(LOYALTY_REDEMPTION_STATES),
		channel: z.enum(LOYALTY_CHANNELS),
		sourceType: z.enum(LOYALTY_PURCHASE_SOURCES).nullable(),
		sourceId: z.string().nullable(),
		locationId: z.string().nullable(),
		currency: currencySchema,
		discountMinor: minorSchema,
		reviewReason: z.enum(LOYALTY_REVIEW_REASONS).nullable(),
		createdAt: msSchema,
		updatedAt: msSchema,
	})
	.strict()
export type LoyaltyOperatorRedemption = z.infer<
	typeof loyaltyOperatorRedemptionSchema
>

export const loyaltyMemberDetailResponseSchema = z
	.object({
		member: loyaltyMemberSummarySchema,
		entries: z.array(loyaltyOperatorLedgerEntrySchema),
		purchases: z.array(loyaltyOperatorPurchaseSchema),
		redemptions: z.array(loyaltyOperatorRedemptionSchema),
		/** Activity at locations the operator cannot see was left out. */
		filteredByLocation: z.boolean(),
	})
	.strict()

export const loyaltyCustomerMemberResponseSchema = z
	.object({ member: loyaltyMemberSummarySchema.nullable() })
	.strict()

export const loyaltyActivityResponseSchema = z
	.object({
		entries: z.array(loyaltyOperatorLedgerEntrySchema),
		nextCursor: z.string().nullable(),
	})
	.strict()

/**
 * A source the outbox gave up on with nothing of it waiting in review (the
 * sale had already settled, or its only hold has ended since). It keeps the
 * tick's parked count up until an operator tries it again with
 * `POST /operator/loyalty/requeue`.
 */
export const loyaltyOperatorParkedSourceSchema = z
	.object({
		sourceType: z.enum(LOYALTY_PURCHASE_SOURCES),
		sourceId: z.string(),
		memberId: idSchema.nullable(),
		locationId: z.string().nullable(),
		attempts: z.number().int().nonnegative(),
		/** An error code, never a payload. */
		lastError: z.string().nullable(),
		parkedAt: msSchema,
	})
	.strict()
export type LoyaltyOperatorParkedSource = z.infer<
	typeof loyaltyOperatorParkedSourceSchema
>

export const loyaltyReviewResponseSchema = z
	.object({
		redemptions: z.array(loyaltyOperatorRedemptionSchema),
		purchases: z.array(loyaltyOperatorPurchaseSchema),
		parked: z.array(loyaltyOperatorParkedSourceSchema),
	})
	.strict()

/**
 * `queued: false` means nothing was left to reconcile on the source, so its
 * parked row was closed instead of queued again.
 */
export const loyaltyRequeueResponseSchema = z
	.object({ queued: z.boolean() })
	.strict()

export const loyaltyResolveRedemptionRequestSchema = z
	.object({
		action: z.enum(['consume', 'release']),
		note: z.string().trim().min(3).max(280),
	})
	.strict()

export const loyaltyResolvePurchaseRequestSchema = z
	.object({
		action: z.enum(['award', 'exclude']),
		note: z.string().trim().min(3).max(280),
	})
	.strict()

/**
 * Money returned for a QR tab paid from the phone, recorded by an operator (no
 * provider refund events reach the region). Audited; takes back points and,
 * on a full refund, restores the reward the tab used. An online order's
 * refunds are recorded on the order instead, and loyalty reads them there.
 */
export const loyaltyRecordRefundRequestSchema = z
	.object({
		source: z
			.object({
				type: z.enum(['qr_tab']),
				id: z.string().min(1).max(64),
			})
			.strict(),
		/** Omit with `full: true` to refund what is left. */
		amountMinor: positiveMinorSchema.optional(),
		full: z.boolean().default(false),
		note: z.string().trim().min(3).max(280),
	})
	.strict()
	.refine((value) => value.full || value.amountMinor !== undefined, {
		message: 'An amount or a full refund is required',
		path: ['amountMinor'],
	})

export const loyaltyRefundResultSchema = z
	.object({
		refundId: idSchema,
		purchaseId: idSchema.nullable(),
		refundedMinor: minorSchema,
		cumulativeRefundedMinor: minorSchema,
		pointsReversed: z.number().int().nonnegative(),
		fullRefund: z.boolean(),
		rewardRestored: z.boolean(),
	})
	.strict()

export const loyaltyAdjustmentResponseSchema = z
	.object({
		entry: loyaltyOperatorLedgerEntrySchema,
		balance: loyaltyOperatorBalanceSchema,
	})
	.strict()
