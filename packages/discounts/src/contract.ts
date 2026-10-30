import { z } from 'zod'
import {
	DISCOUNT_CODE_PATTERN,
	DISCOUNT_MAX_MINOR,
	discountDefinitionSchema,
} from './definition.ts'
import { DISCOUNT_REFUSAL_REASONS } from './evaluate.ts'

/**
 * Wire contracts between App, tenant-api and Sites (docs/discounts-plan.md).
 * The browser never sends a price: `expectedDiscountMinor` is only compared
 * against what the region computes, and a difference refuses the order.
 */

const minorSchema = z.number().int().min(0).max(DISCOUNT_MAX_MINOR)

/** What a customer typed. Validated loosely: normalizing happens server-side. */
export const discountCodeInputSchema = z
	.string()
	.trim()
	.min(1)
	.max(40)
	.refine(
		(value) => DISCOUNT_CODE_PATTERN.test(value.replace(/\s+/g, '-')),
		'Not a valid code',
	)

/** The `discounts` field of an order or quote request. */
export const orderDiscountsRequestSchema = z
	.object({
		code: discountCodeInputSchema.optional(),
		/** Total discount (items + delivery) the customer was shown. Orders only. */
		expectedDiscountMinor: minorSchema.optional(),
	})
	.strict()
export type OrderDiscountsRequest = z.infer<typeof orderDiscountsRequestSchema>

/** A stored discount as the region receives it in the order context. */
export const discountRecordSchema = discountDefinitionSchema.safeExtend({
	id: z.string().min(1).max(100),
	version: z.number().int().min(1),
	createdAt: z.string().min(1),
})

export const discountCodeRecordSchema = z
	.object({
		id: z.string().min(1).max(100),
		discountId: z.string().min(1).max(100),
		normalizedCode: z.string().min(3).max(24),
		maxUses: z.number().int().min(1).nullable(),
	})
	.strict()

/** Added to `GET /resources/order-context`. A missing field reads as off. */
export const orderContextDiscountsSchema = z
	.object({
		features: z
			.object({ automatic: z.boolean(), coupons: z.boolean() })
			.strict(),
		/** Active, unexpired definitions (automatic and code applications). */
		discounts: z.array(discountRecordSchema).max(500),
		codes: z.array(discountCodeRecordSchema).max(2000),
	})
	.strict()
export type OrderContextDiscounts = z.infer<typeof orderContextDiscountsSchema>

export const discountCodeOutcomeSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('applied') }).strict(),
	z
		.object({
			status: z.literal('refused'),
			reason: z.enum(DISCOUNT_REFUSAL_REASONS),
		})
		.strict(),
	z
		.object({
			status: z.literal('replaced'),
			reason: z.literal('replaced_by_better_discount'),
		})
		.strict(),
])

/** Response of `POST /orders/quote`. */
export const discountQuoteSchema = z
	.object({
		currency: z.string().regex(/^[A-Z]{3}$/),
		subtotalMinor: minorSchema,
		discounts: z.array(
			z
				.object({
					discountId: z.string(),
					version: z.number().int(),
					name: z.string(),
					/** The code as the customer typed it, when one was used. */
					code: z.string().nullable(),
					amountMinor: minorSchema,
					deliveryAmountMinor: minorSchema,
					lineIds: z.array(z.string()),
				})
				.strict(),
		),
		/** Items plus delivery, what `expectedDiscountMinor` must equal. */
		totalDiscountMinor: minorSchema,
		loyaltyDiscountMinor: minorSchema,
		taxMinor: minorSchema,
		tipMinor: minorSchema,
		deliveryFeeMinor: minorSchema,
		deliveryDiscountMinor: minorSchema,
		totalMinor: minorSchema,
		/** False when the total is 0: the order skips payment. */
		paymentRequired: z.boolean(),
		/** Null when no code was sent. */
		coupon: discountCodeOutcomeSchema.nullable(),
	})
	.strict()
export type DiscountQuote = z.infer<typeof discountQuoteSchema>

/** Error codes the region answers with (HTTP 409 unless noted). */
export const DISCOUNT_ERROR_CODES = [
	/** The discount differs from `expectedDiscountMinor`; the body carries a fresh quote. */
	'discount_changed',
	/** A code was sent and refused; the body carries the reason. */
	'coupon_refused',
	/** HTTP 503: the node kill switch `DISCOUNTS_ENABLED` is off. */
	'discounts_disabled',
	/** QR tab rounds take no discounts until phase 2. */
	'discounts_on_tab',
] as const
export type DiscountErrorCode = (typeof DISCOUNT_ERROR_CODES)[number]
