import { z } from 'zod'
import { LOYALTY_APPROVAL_STATUSES } from '../codes.ts'
import { type LoyaltyErrorCode } from '../errors.ts'
import {
	LOYALTY_ADJUSTMENT_REASONS,
	LOYALTY_CHANNELS,
	LOYALTY_LEDGER_TYPES,
} from '../ledger.ts'
import { currencySchema, minorSchema } from '../money.ts'
import {
	loyaltyCatalogIdSchema,
	loyaltyCatalogLabelsSchema,
	LOYALTY_EARNING_METHODS,
	loyaltyEarningRuleSchema,
	LOYALTY_UNIT_LABELS,
	type LoyaltyUnitLabel,
} from '../program.ts'
import { LOYALTY_EXPIRY_MODES } from '../expiry.ts'
import { LOYALTY_MULTIPLIER_ONE_BP } from '../money.ts'
import { LOYALTY_REFERRAL_STATUSES } from '../referrals.ts'
import { LOYALTY_REWARD_KINDS, loyaltyDiscountSchema } from '../rewards.ts'
import { LOYALTY_TIER_METRICS, loyaltyTierIdSchema } from '../tiers.ts'

/**
 * Customer-facing contract: `/loyalty/*` on the regional tenant-api, called
 * from the website and the native apps. The organization comes from the
 * request origin (or the native app's site address), the person from the
 * verified customer token. Responses carry the member's own data only.
 *
 * Response schemas parse leniently (unknown fields are ignored): a deployed
 * app must keep working when the region starts sending more. Request schemas
 * stay `.strict()`, so a call the region cannot understand is refused.
 *
 * Values added after a client shipped never fail a whole answer. A list drops
 * the rewards, history entries and approvals it cannot describe; any other
 * new value decodes as `'unknown'`, which the apps hide rather than read as
 * a known one. A known value with a broken shape still fails.
 */

/** What an answer carries in place of a value this client does not know. */
export const LOYALTY_UNKNOWN_VALUE = 'unknown'
export type LoyaltyUnknownValue = typeof LOYALTY_UNKNOWN_VALUE

function isUnknownValue(known: readonly string[], value: unknown): boolean {
	return typeof value === 'string' && !known.includes(value)
}

function openEnum<const Values extends readonly [string, ...string[]]>(
	values: Values,
) {
	return z
		.string()
		.transform((value): Values[number] | LoyaltyUnknownValue =>
			(values as readonly string[]).includes(value)
				? (value as Values[number])
				: LOYALTY_UNKNOWN_VALUE,
		)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A list without the elements `isUnknown` rejects; the rest parse in full. */
function knownElements<Element extends z.ZodTypeAny>(
	element: Element,
	isUnknown: (item: Record<string, unknown>) => boolean,
) {
	return z.preprocess(
		(value) =>
			Array.isArray(value)
				? value.filter((item) => !(isRecord(item) && isUnknown(item)))
				: value,
		z.array(element),
	)
}

const idSchema = z.string().min(1).max(64)
const msSchema = z.number().int().nonnegative()
const pointsSchema = z.number().int()

const labelsSchema = loyaltyCatalogLabelsSchema.strip()

const [fixedDiscount, percentDiscount] = loyaltyDiscountSchema.options
const DISCOUNT_TYPES = loyaltyDiscountSchema.options.map(
	(option) => option.shape.type.value,
)
const discountSchema = z.discriminatedUnion('type', [
	fixedDiscount.strip(),
	percentDiscount.strip(),
])

const [spendRule, visitRule, itemsRule, categoriesRule] =
	loyaltyEarningRuleSchema.options

/** The earning rule; one this client cannot describe is `{ method: 'unknown' }`. */
export const loyaltyPublicEarningSchema = z.union([
	z.discriminatedUnion('method', [
		spendRule.strip(),
		visitRule.strip(),
		itemsRule.strip(),
		categoriesRule.strip(),
	]),
	z
		.object({
			method: z
				.string()
				.refine((method) => isUnknownValue(LOYALTY_EARNING_METHODS, method)),
		})
		.transform((): { method: LoyaltyUnknownValue } => ({
			method: LOYALTY_UNKNOWN_VALUE,
		})),
])
export type LoyaltyPublicEarning = z.infer<typeof loyaltyPublicEarningSchema>

/** The program's unit label, or `'unknown'`: then counts show without a unit. */
export const loyaltyPublicUnitLabelSchema = openEnum(LOYALTY_UNIT_LABELS)
export type LoyaltyPublicUnitLabel = LoyaltyUnitLabel | LoyaltyUnknownValue

export const loyaltyPublicRewardSchema = z.object({
	id: idSchema,
	version: z.number().int().min(1),
	name: z.string(),
	description: z.string().nullable(),
	pointsCost: z.number().int().min(1),
	kind: z.enum(LOYALTY_REWARD_KINDS),
	/** Null for a free item. */
	discount: discountSchema.nullable(),
	itemIds: z.array(loyaltyCatalogIdSchema),
	categoryIds: z.array(loyaltyCatalogIdSchema),
	freeItemId: loyaltyCatalogIdSchema.nullable(),
	labels: labelsSchema,
	currency: currencySchema,
	minTierId: loyaltyTierIdSchema.nullable().default(null),
	minTierName: z.string().nullable().default(null),
	lockedByTier: z.boolean().default(false),
})
export type LoyaltyPublicReward = z.infer<typeof loyaltyPublicRewardSchema>

/** Rewards of a kind or discount this client cannot describe are left out. */
const publicRewardsSchema = knownElements(
	loyaltyPublicRewardSchema,
	(reward) =>
		isUnknownValue(LOYALTY_REWARD_KINDS, reward.kind) ||
		(isRecord(reward.discount) &&
			isUnknownValue(DISCOUNT_TYPES, reward.discount.type)),
)

export const loyaltyPublicProgramSchema = z.object({
	name: z.string(),
	unitLabel: loyaltyPublicUnitLabelSchema,
	currency: currencySchema,
	status: z.enum(['active', 'paused']),
	earning: loyaltyPublicEarningSchema,
	minimumSpendMinor: minorSchema,
	labels: labelsSchema,
	/** Display text for the wallet; null when the program has none. */
	terms: z.string().nullable(),
	rewards: publicRewardsSchema,
	/** Rewards can be spent (the redemption flag is on). */
	redemptionEnabled: z.boolean(),
	welcomeBonus: z
		.object({
			enabled: z.boolean(),
			points: z.number().int().nonnegative(),
			afterFirstPaidOrder: z.boolean(),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	tiers: z
		.object({
			metric: z.enum(LOYALTY_TIER_METRICS),
			periodMonths: z.number().int().min(1),
			graceDays: z.number().int().nonnegative(),
			levels: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					threshold: z.number().int().min(1),
					multiplierBp: z.number().int().min(LOYALTY_MULTIPLIER_ONE_BP),
				}),
			),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	expiry: z
		.object({
			mode: z.enum(LOYALTY_EXPIRY_MODES),
			months: z.number().int().min(1),
			enabledAt: msSchema.nullable().optional().default(null),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	referrals: z
		.object({
			enabled: z.boolean(),
			referrerPoints: z.number().int().nonnegative(),
			friendPoints: z.number().int().nonnegative(),
			friendDiscount: discountSchema.nullable(),
			minimumOrderMinor: minorSchema,
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
})
export type LoyaltyPublicProgram = z.infer<typeof loyaltyPublicProgramSchema>

export const loyaltyProgramResponseSchema = z.object({
	program: loyaltyPublicProgramSchema.nullable(),
})

export const loyaltyBalanceSchema = z.object({
	points: pointsSchema,
	reserved: z.number().int().nonnegative(),
	/** Spendable now. Negative while the member owes points. */
	available: pointsSchema,
})
export type LoyaltyBalanceView = z.infer<typeof loyaltyBalanceSchema>

export const loyaltyWalletSchema = z.object({
	program: loyaltyPublicProgramSchema,
	member: z
		.object({
			id: idSchema,
			status: z.enum(['active', 'suspended']),
		})
		/**
		 * The customer's points account. Opened by the wallet read itself for a
		 * signed-in verified customer, so it is null only when the program is
		 * unavailable or the account was erased.
		 */
		.nullable(),
	balance: loyaltyBalanceSchema.nullable(),
	/** The cheapest active reward the member cannot afford yet. */
	nextReward: z
		.object({ rewardId: idSchema, pointsNeeded: z.number().int().min(1) })
		.nullable(),
	pendingApprovals: z.number().int().nonnegative(),
	welcomeBonus: z
		.object({
			status: z.enum(['granted', 'pending_first_order', 'ineligible', 'none']),
			points: z.number().int().nonnegative(),
			grantedAt: msSchema.nullable(),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	tier: z
		.object({
			current: z
				.object({
					id: z.string(),
					name: z.string(),
					multiplierBp: z.number().int(),
				})
				.nullable(),
			next: z
				.object({
					id: z.string(),
					name: z.string(),
					threshold: z.number().int(),
					pointsRemaining: z.number().int().nonnegative(),
					multiplierBp: z.number().int(),
				})
				.nullable(),
			metric: z.enum(LOYALTY_TIER_METRICS),
			progressValue: z.number().int().nonnegative(),
			periodMonths: z.number().int().min(1),
			reviewAt: msSchema.nullable(),
			graceUntil: msSchema.nullable(),
			pendingDowngradeTierName: z.string().nullable(),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	expiry: z
		.object({
			mode: z.enum(LOYALTY_EXPIRY_MODES),
			months: z.number().int().min(1),
			nextExpiryAt: msSchema.nullable(),
			nextExpiryPoints: z.number().int().nonnegative(),
			expiringWithin30d: z.number().int().nonnegative(),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
	referral: z
		.object({
			code: z.string(),
			sharePath: z.string(),
			referredCount: z.number().int().nonnegative(),
			pendingCount: z.number().int().nonnegative(),
			creditedCount: z.number().int().nonnegative(),
			creditedPoints: z.number().int().nonnegative(),
			capReached: z.boolean(),
			maxReferralsPerMember: z.number().int().positive(),
		})
		.nullable()
		.optional()
		.default(null)
		.catch(null),
})
export type LoyaltyWallet = z.infer<typeof loyaltyWalletSchema>

export const loyaltyWalletResponseSchema = z.object({
	wallet: loyaltyWalletSchema.nullable(),
})

export const loyaltyHistoryEntrySchema = z.object({
	id: idSchema,
	at: msSchema,
	type: z.enum(LOYALTY_LEDGER_TYPES),
	delta: z.number().int(),
	channel: openEnum(LOYALTY_CHANNELS).nullable(),
	rewardName: z.string().nullable(),
	reason: openEnum(LOYALTY_ADJUSTMENT_REASONS).nullable(),
})
export type LoyaltyHistoryEntry = z.infer<typeof loyaltyHistoryEntrySchema>

export const loyaltyHistoryResponseSchema = z.object({
	/** Entries of a type this client cannot describe are left out. */
	entries: knownElements(loyaltyHistoryEntrySchema, (entry) =>
		isUnknownValue(LOYALTY_LEDGER_TYPES, entry.type),
	),
	nextCursor: z.string().nullable(),
})

export const loyaltyMemberCodeResponseSchema = z.object({
	/** Display form, `ABCD-EFGH`. */
	code: z.string(),
	expiresAt: msSchema,
})

export const loyaltyCustomerApprovalSchema = z.object({
	id: idSchema,
	status: openEnum(LOYALTY_APPROVAL_STATUSES),
	rewardName: z.string(),
	pointsCost: z.number().int().min(1),
	discountMinor: minorSchema,
	currency: currencySchema,
	createdAt: msSchema,
	expiresAt: msSchema,
})
export type LoyaltyCustomerApproval = z.infer<
	typeof loyaltyCustomerApprovalSchema
>

export const loyaltyApprovalsResponseSchema = z.object({
	/** Approvals in a status this client cannot describe are left out. */
	approvals: knownElements(loyaltyCustomerApprovalSchema, (approval) =>
		isUnknownValue(LOYALTY_APPROVAL_STATUSES, approval.status),
	),
})

export const loyaltyApprovalResponseSchema = z.object({
	approval: loyaltyCustomerApprovalSchema,
})

/** Quote for one reward against a priced cart (checkout or till). */
export const loyaltyRewardQuoteSchema = z.object({
	rewardId: idSchema,
	rewardVersion: z.number().int().min(1),
	applicable: z.boolean(),
	/**
	 * Why it does not apply (or cannot be afforded); null when it does.
	 * Parsed leniently on purpose: a refusal code added after a client
	 * shipped must still parse (`isLoyaltyErrorCode` is the runtime gate).
	 */
	code: z
		.custom<LoyaltyErrorCode>((value) => typeof value === 'string')
		.nullable(),
	discountMinor: minorSchema,
	pointsCost: z.number().int().min(1),
	affordable: z.boolean(),
	eligibleLineIds: z.array(z.string()),
	lines: z.array(
		z.object({
			lineId: z.string(),
			discountMinor: minorSchema,
			rewardUnits: z.number().int().nonnegative(),
		}),
	),
	targetLineId: z.string().nullable(),
})
export type LoyaltyRewardQuote = z.infer<typeof loyaltyRewardQuoteSchema>

export const loyaltyCheckoutTotalsSchema = z.object({
	subtotalMinor: minorSchema,
	discountMinor: minorSchema,
	taxMinor: minorSchema,
	taxInclusive: z.boolean(),
	tipMinor: minorSchema,
	deliveryFeeMinor: minorSchema,
	/** The guest service fee (#123) before its tax; missing reads as 0. */
	serviceFeeMinor: minorSchema.optional(),
	totalMinor: minorSchema,
})

export const loyaltyCheckoutQuoteResponseSchema = z.object({
	currency: currencySchema,
	unitLabel: loyaltyPublicUnitLabelSchema,
	balance: loyaltyBalanceSchema,
	rewards: z.array(loyaltyRewardQuoteSchema),
	/** Totals with the selected reward (or without any when none is selected). */
	totals: loyaltyCheckoutTotalsSchema,
	selectedRewardId: idSchema.nullable(),
	/** Available after the selected reward is spent. */
	availableAfter: z.number().int(),
})
export type LoyaltyCheckoutQuote = z.infer<
	typeof loyaltyCheckoutQuoteResponseSchema
>

/** The reward a customer picked at checkout, sent with the order. */
export const loyaltyOrderRewardSchema = z
	.object({
		rewardId: idSchema,
		/** The version the customer saw; a changed reward is re-quoted. */
		rewardVersion: z.number().int().min(1).max(1_000_000),
		/** The discount the customer saw; a different result is refused. */
		expectedDiscountMinor: minorSchema,
		targetLineId: z.string().min(1).max(100).nullable().default(null),
	})
	.strict()
export type LoyaltyOrderReward = z.infer<typeof loyaltyOrderRewardSchema>

/**
 * `POST /loyalty/checkout/quote` request. `order` is the restaurant order
 * request (`restaurantOrderQuoteSchema` in
 * `@repo/common/restaurant-orders`: the placement shape minus the
 * idempotency key and contact, which a read does not need); the loyalty
 * package cannot import it, so it is opaque here and the route parses
 * it with the real schema. `selection` is the reward the customer picked,
 * when they did; the answer then carries the discounted totals.
 */
export const loyaltyCheckoutQuoteRequestSchema = z
	.object({
		order: z.unknown(),
		selection: loyaltyOrderRewardSchema.nullable().default(null),
	})
	.strict()
export type LoyaltyCheckoutQuoteRequest = z.infer<
	typeof loyaltyCheckoutQuoteRequestSchema
>

/**
 * `POST /loyalty/tab/quote` request (the tab code rides in `X-Tab-Token`):
 * every reward priced on the open tab's rounds, with the tip the guest picked
 * (a share of the subtotal, like the tab payment). The answer has the same
 * shape as the checkout quote.
 */
export const loyaltyTabQuoteRequestSchema = z
	.object({
		tipPercent: z.number().int().min(0).max(30).default(0),
		/**
		 * The tip as a share or an exact amount (#118); sent instead of
		 * `tipPercent`. The same shape as `orderTipSchema` in `@repo/common`.
		 */
		tip: z
			.union([
				z.strictObject({ percent: z.number().int().min(0).max(30) }),
				z.strictObject({
					amountMinor: z.number().int().min(0).max(1_000_000_000),
				}),
			])
			.optional(),
		selection: loyaltyOrderRewardSchema.nullable().default(null),
	})
	.strict()
export type LoyaltyTabQuoteRequest = z.infer<
	typeof loyaltyTabQuoteRequestSchema
>

export const loyaltyErrorResponseSchema = z
	.object({
		error: z.string(),
		code: z.string(),
	})
	.passthrough()

export const loyaltyReferralPublicSchema = z.object({
	valid: z.boolean(),
	code: z.string(),
	referrerFirstName: z.string().nullable(),
	friendDiscount: discountSchema.nullable(),
	friendPoints: z.number().int().nonnegative(),
	minimumOrderMinor: minorSchema,
})
export type LoyaltyReferralPublic = z.infer<typeof loyaltyReferralPublicSchema>

export const loyaltyReferralPublicResponseSchema = z.object({
	referral: loyaltyReferralPublicSchema.nullable(),
})

export const loyaltyReferralClaimRequestSchema = z
	.object({
		code: z.string().trim().min(1).max(32),
		deviceId: z.string().trim().min(1).max(128).optional(),
	})
	.strict()
export type LoyaltyReferralClaimRequest = z.infer<
	typeof loyaltyReferralClaimRequestSchema
>

export const loyaltyReferralClaimResponseSchema = z.object({
	referral: z.object({
		id: idSchema,
		code: z.string(),
		status: z.enum(LOYALTY_REFERRAL_STATUSES),
		discountCode: z.string().nullable(),
		friendDiscount: discountSchema.nullable(),
		friendPoints: z.number().int().nonnegative(),
		minimumOrderMinor: minorSchema,
	}),
})
export type LoyaltyReferralClaimResponse = z.infer<
	typeof loyaltyReferralClaimResponseSchema
>
