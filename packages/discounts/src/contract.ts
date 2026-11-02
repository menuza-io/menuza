import { z } from 'zod'
import {
	DISCOUNT_CODE_PATTERN,
	DISCOUNT_MAX_MINOR,
	discountDefinitionSchema,
	foldDiscountCodeCharacters,
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
		(value) =>
			DISCOUNT_CODE_PATTERN.test(
				foldDiscountCodeCharacters(value).trim().replace(/\s+/g, '-'),
			),
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
	/** ISO instant; ties between equal priorities go to the older one. */
	createdAt: z.iso.datetime({ offset: true }),
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

const MAX_CONTEXT_DISCOUNTS = 500
const MAX_CONTEXT_CODES = 2000

const contextFeaturesSchema = z
	.object({ automatic: z.boolean(), coupons: z.boolean() })
	.strict()

export type ParsedOrderContextDiscounts = {
	/** Undefined when the field is missing or its `features` are unusable: off. */
	value: OrderContextDiscounts | undefined
	/** Discount records left out because they did not parse (or past the cap). */
	droppedDiscounts: number
	/** Code rows left out because they did not parse (or past the cap). */
	droppedCodes: number
	/** Ids of the left-out records, at most 20 of each, for the log. Never codes. */
	droppedDiscountIds: string[]
	droppedCodeIds: string[]
}

const idOf = (row: unknown): string => {
	const id =
		row && typeof row === 'object' ? (row as { id?: unknown }).id : undefined
	return typeof id === 'string' ? id.slice(0, 100) : '?'
}

/**
 * Reads the `discounts` field of an order context one record at a time: a
 * discount or code row that does not match its strict schema is dropped and
 * counted, the valid ones stay. One bad row must not switch every discount
 * off for the organization. Each record is as strict as before; only the
 * all-or-nothing wrapper is gone. Unknown top-level keys are ignored.
 */
export function parseOrderContextDiscounts(
	raw: unknown,
): ParsedOrderContextDiscounts {
	const none: ParsedOrderContextDiscounts = {
		value: undefined,
		droppedDiscounts: 0,
		droppedCodes: 0,
		droppedDiscountIds: [],
		droppedCodeIds: [],
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return none
	const field = raw as {
		features?: unknown
		discounts?: unknown
		codes?: unknown
	}
	const features = contextFeaturesSchema.safeParse(field.features)
	if (!features.success) return none
	if (!Array.isArray(field.discounts) || !Array.isArray(field.codes)) {
		return none
	}
	const result: ParsedOrderContextDiscounts = {
		value: { features: features.data, discounts: [], codes: [] },
		droppedDiscounts: 0,
		droppedCodes: 0,
		droppedDiscountIds: [],
		droppedCodeIds: [],
	}
	const value = result.value!
	for (const row of field.discounts) {
		const parsed =
			value.discounts.length < MAX_CONTEXT_DISCOUNTS
				? discountRecordSchema.safeParse(row)
				: null
		if (parsed?.success) {
			value.discounts.push(parsed.data)
			continue
		}
		result.droppedDiscounts += 1
		if (result.droppedDiscountIds.length < 20) {
			result.droppedDiscountIds.push(idOf(row))
		}
	}
	for (const row of field.codes) {
		const parsed =
			value.codes.length < MAX_CONTEXT_CODES
				? discountCodeRecordSchema.safeParse(row)
				: null
		if (parsed?.success) {
			value.codes.push(parsed.data)
			continue
		}
		result.droppedCodes += 1
		if (result.droppedCodeIds.length < 20) {
			result.droppedCodeIds.push(idOf(row))
		}
	}
	return result
}

/**
 * Schema form of `parseOrderContextDiscounts` for the region's order-context
 * schema: yields the valid records, or undefined (off) when the field is
 * unusable. Dropped records are logged by id and count only, never by code or
 * name.
 */
export const orderContextDiscountsTolerantSchema = z
	.unknown()
	.transform((raw): OrderContextDiscounts | undefined => {
		if (raw === undefined || raw === null) return undefined
		const parsed = parseOrderContextDiscounts(raw)
		if (!parsed.value) {
			console.warn('order-context: discounts field unusable, discounts are off')
		} else if (parsed.droppedDiscounts > 0 || parsed.droppedCodes > 0) {
			console.warn(
				`order-context: dropped ${parsed.droppedDiscounts} discount(s) [${parsed.droppedDiscountIds.join(',')}] and ${parsed.droppedCodes} code row(s) [${parsed.droppedCodeIds.join(',')}] that did not parse`,
			)
		}
		return parsed.value
	})

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

/**
 * Response of `POST /orders/quote`. Unknown fields are ignored so one new
 * field from the region does not break checkout during a rollout.
 */
export const discountQuoteSchema = z.object({
	currency: z.string().regex(/^[A-Z]{3}$/),
	subtotalMinor: minorSchema,
	discounts: z.array(
		z.object({
			discountId: z.string(),
			version: z.number().int(),
			name: z.string(),
			/** `name` per website language; pick with `localizedDiscountText`. */
			nameI18n: z.record(z.string(), z.string()).optional(),
			/** The code as the customer typed it, when one was used. */
			code: z.string().nullable(),
			amountMinor: minorSchema,
			deliveryAmountMinor: minorSchema,
			lineIds: z.array(z.string()),
		}),
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
	/**
	 * Whether the organization takes coupon codes right now, so checkout can
	 * hide the code field. Missing (an older region) reads as true.
	 */
	couponsEnabled: z.boolean().optional(),
})
export type DiscountQuote = z.infer<typeof discountQuoteSchema>

/** Error codes the region answers with (HTTP 409 unless noted). */
export const DISCOUNT_ERROR_CODES = [
	/** The discount differs from `expectedDiscountMinor`; the body carries a fresh quote. */
	'discount_changed',
	/** A code was sent and refused; the body carries the reason. */
	'coupon_refused',
	/** HTTP 503: the node kill switch `DISCOUNTS_ENABLED` is off. */
	'discounts_disabled',
	/** A tab round cannot carry a discount. Discounts apply when the tab is paid. */
	'discounts_on_tab',
] as const
export type DiscountErrorCode = (typeof DISCOUNT_ERROR_CODES)[number]
