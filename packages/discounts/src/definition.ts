import { z } from 'zod'

/**
 * A discount as an operator configures it. The same shape is the App form's
 * validation, the control-plane row (JSON columns hold the nested parts), the
 * order-context payload and the frozen snapshot on a redemption.
 */

export const DISCOUNT_APPLICATION_VALUES = [
	'automatic',
	'code',
	'manual',
] as const
export type DiscountApplication = (typeof DISCOUNT_APPLICATION_VALUES)[number]

export const DISCOUNT_STATUS_VALUES = ['active', 'paused', 'archived'] as const
export type DiscountStatus = (typeof DISCOUNT_STATUS_VALUES)[number]

export const DISCOUNT_VALUE_TYPE_VALUES = [
	'percent',
	'fixed',
	'free_delivery',
] as const
export type DiscountValueType = (typeof DISCOUNT_VALUE_TYPE_VALUES)[number]

export const DISCOUNT_CHANNEL_VALUES = ['web', 'qr', 'pos', 'app'] as const
export type DiscountChannel = (typeof DISCOUNT_CHANNEL_VALUES)[number]

export const DISCOUNT_FULFILLMENT_VALUES = [
	'pickup',
	'delivery',
	'dine_in',
] as const
export type DiscountFulfillment = (typeof DISCOUNT_FULFILLMENT_VALUES)[number]

export const DISCOUNT_ELIGIBILITY_VALUES = [
	'everyone',
	'signed_in',
	'new_customer',
	'loyalty_member',
] as const
export type DiscountEligibility = (typeof DISCOUNT_ELIGIBILITY_VALUES)[number]

export const DISCOUNT_LIMIT_PERIOD_VALUES = ['lifetime', 'day', 'week'] as const
export type DiscountLimitPeriod = (typeof DISCOUNT_LIMIT_PERIOD_VALUES)[number]

/** Owner.com's "maximum use" presets; any positive whole number is allowed. */
export const DISCOUNT_TOTAL_LIMIT_PRESETS = [
	1, 10, 25, 50, 100, 250, 500,
] as const

export const DISCOUNT_MAX_MINOR = 1_000_000_000_000
export const DISCOUNT_NAME_MAX = 60
export const DISCOUNT_DESCRIPTION_MAX = 75
export const DISCOUNT_MAX_TARGET_ITEMS = 200
export const DISCOUNT_MAX_TARGET_CATEGORIES = 100
export const DISCOUNT_MAX_SCHEDULE_WINDOWS = 28
export const DISCOUNT_MAX_UNITS = 1000

/** 3 to 24 characters: letters, digits and dashes. Matched case-insensitively. */
export const DISCOUNT_CODE_PATTERN = /^[A-Za-z0-9-]{3,24}$/

/** Upper case, no spaces or dashes: what is stored, compared and rate limited. */
export function normalizeDiscountCode(value: string): string {
	return value.replace(/[\s-]+/g, '').toUpperCase()
}

const catalogIdSchema = z.string().min(1).max(100)
const minorSchema = z.number().int().min(0).max(DISCOUNT_MAX_MINOR)
const localDateTimeSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM')
const timeOfDaySchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')

export const discountTargetSchema = z
	.object({
		scope: z.enum(['order', 'items', 'categories']),
		itemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		categoryIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_CATEGORIES),
		excludeItemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		excludeCategoryIds: z
			.array(catalogIdSchema)
			.max(DISCOUNT_MAX_TARGET_CATEGORIES),
	})
	.strict()
export type DiscountTarget = z.infer<typeof discountTargetSchema>

/** "When the customer buys any N of these": a gate, not consumed by the discount. */
export const discountRequirementSchema = z
	.object({
		quantity: z.number().int().min(1).max(DISCOUNT_MAX_UNITS),
		itemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		categoryIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_CATEGORIES),
	})
	.strict()
export type DiscountRequirement = z.infer<typeof discountRequirementSchema>

const quantityNumber = z.number().int().min(1).max(DISCOUNT_MAX_UNITS)
export const discountQuantityRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }).strict(),
	z.object({ kind: z.literal('exact'), quantity: quantityNumber }).strict(),
	z.object({ kind: z.literal('minimum'), quantity: quantityNumber }).strict(),
	z
		.object({
			kind: z.literal('bogo'),
			buyQuantity: quantityNumber,
			getQuantity: quantityNumber,
		})
		.strict(),
])
export type DiscountQuantityRule = z.infer<typeof discountQuantityRuleSchema>

export const discountScheduleWindowSchema = z
	.object({
		/** 0 = Sunday ... 6 = Saturday, like `dayOfWeek` in `@repo/zoned-time`. */
		day: z.number().int().min(0).max(6),
		start: timeOfDaySchema,
		/** Before `start` means the window runs past midnight into the next day. */
		end: timeOfDaySchema,
	})
	.strict()
	.refine((window) => window.start !== window.end, {
		message: 'Start and end must differ',
		path: ['end'],
	})
export type DiscountScheduleWindow = z.infer<
	typeof discountScheduleWindowSchema
>

export const discountPerCustomerLimitSchema = z
	.object({
		count: z.number().int().min(1).max(10_000),
		period: z.enum(DISCOUNT_LIMIT_PERIOD_VALUES),
	})
	.strict()
export type DiscountPerCustomerLimit = z.infer<
	typeof discountPerCustomerLimitSchema
>

export const discountDefinitionSchema = z
	.object({
		name: z.string().trim().min(1).max(DISCOUNT_NAME_MAX),
		internalName: z.string().trim().max(DISCOUNT_NAME_MAX).nullable(),
		description: z.string().trim().max(DISCOUNT_DESCRIPTION_MAX).nullable(),
		status: z.enum(DISCOUNT_STATUS_VALUES),
		application: z.enum(DISCOUNT_APPLICATION_VALUES),
		valueType: z.enum(DISCOUNT_VALUE_TYPE_VALUES),
		/** Basis points, 1 to 10000. Percent only. */
		percentBp: z.number().int().min(1).max(10_000).nullable(),
		/** Fixed only, in minor units of `currency`. */
		amountMinor: minorSchema.min(1).nullable(),
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/)
			.nullable(),
		/** Cap per order. Percent only (Square "maximum discount value"). */
		maxDiscountMinor: minorSchema.min(1).nullable(),
		target: discountTargetSchema,
		requirement: discountRequirementSchema.nullable(),
		quantityRule: discountQuantityRuleSchema,
		/** Items discounted per use. Item and category scope only. */
		maxDiscountedUnits: z
			.number()
			.int()
			.min(1)
			.max(DISCOUNT_MAX_UNITS)
			.nullable(),
		minSubtotalMinor: minorSchema.min(1).nullable(),
		/** Null means every location. */
		locationIds: z.array(catalogIdSchema).max(200).nullable(),
		channels: z.array(z.enum(DISCOUNT_CHANNEL_VALUES)).min(1),
		fulfillments: z.array(z.enum(DISCOUNT_FULFILLMENT_VALUES)).min(1),
		includeDrops: z.boolean(),
		schedule: z
			.array(discountScheduleWindowSchema)
			.max(DISCOUNT_MAX_SCHEDULE_WINDOWS)
			.nullable(),
		/** Local date-times in each location's time zone. */
		startsAt: localDateTimeSchema.nullable(),
		endsAt: localDateTimeSchema.nullable(),
		eligibility: z.enum(DISCOUNT_ELIGIBILITY_VALUES),
		totalLimit: z.number().int().min(1).max(1_000_000).nullable(),
		perCustomerLimit: discountPerCustomerLimitSchema.nullable(),
		combinable: z.boolean(),
		/** Lower runs first and wins ties. */
		priority: z.number().int().min(0).max(1000),
		promoteOnMenu: z.boolean(),
		requireApproval: z.boolean(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (path: string, message: string) =>
			ctx.addIssue({ code: 'custom', path: [path], message })
		if (value.valueType === 'percent') {
			if (value.percentBp === null) issue('percentBp', 'Enter a percentage')
			if (value.amountMinor !== null) issue('amountMinor', 'Not used')
		} else {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.maxDiscountMinor !== null) {
				issue('maxDiscountMinor', 'A maximum only applies to percentages')
			}
		}
		if (value.valueType === 'fixed') {
			if (value.amountMinor === null) issue('amountMinor', 'Enter an amount')
			if (value.currency === null) issue('currency', 'Choose a currency')
		} else if (value.amountMinor !== null) {
			issue('amountMinor', 'Not used')
		}
		if (value.valueType === 'free_delivery') {
			if (value.target.scope !== 'order') {
				issue('target', 'Free delivery applies to the order')
			}
			if (value.quantityRule.kind !== 'none') {
				issue('quantityRule', 'Free delivery has no quantity rule')
			}
			if (!value.fulfillments.includes('delivery')) {
				issue('fulfillments', 'Free delivery needs the delivery order type')
			}
		}
		if (value.target.scope === 'items' && value.target.itemIds.length === 0) {
			issue('target', 'Choose at least one item')
		}
		if (
			value.target.scope === 'categories' &&
			value.target.categoryIds.length === 0
		) {
			issue('target', 'Choose at least one category')
		}
		if (value.target.scope === 'order' && value.maxDiscountedUnits !== null) {
			issue('maxDiscountedUnits', 'Only applies to items or categories')
		}
		if (value.quantityRule.kind === 'bogo' && value.target.scope === 'order') {
			issue('quantityRule', 'Buy one get one needs items or categories')
		}
		if (value.startsAt && value.endsAt && value.endsAt < value.startsAt) {
			issue('endsAt', 'The end must be after the start')
		}
		if (
			value.requirement &&
			value.requirement.itemIds.length === 0 &&
			value.requirement.categoryIds.length === 0 &&
			value.target.scope !== 'order'
		) {
			// "Any item" is only meaningful as a gate on an order-wide discount.
			issue('requirement', 'Choose the items or categories required')
		}
	})
export type DiscountDefinition = z.infer<typeof discountDefinitionSchema>

/** A stored discount: the definition plus what the database adds. */
export type DiscountRecord = DiscountDefinition & {
	id: string
	version: number
	/** ISO instant, used to break ties (older wins). */
	createdAt: string
}

export type DiscountCodeRecord = {
	id: string
	discountId: string
	normalizedCode: string
	/** Square "limit number of times coupon can be redeemed". */
	maxUses: number | null
}
