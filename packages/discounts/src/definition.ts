import { z } from 'zod'
import { discountLocalizedTextSchema } from './localized.ts'
import { discountVariantFiltersSchema } from './variants.ts'

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
	/**
	 * Sets the price instead of taking an amount off: each discounted unit costs
	 * `amountMinor`, or each bundle does when the rule is a bundle.
	 */
	'fixed_price',
	/**
	 * The cashier types the amount at the till. Manual only. The amount is for
	 * the whole selection, spread over the matching units, never per unit.
	 */
	'variable_amount',
	/** The cashier types the percentage at the till. Manual only. */
	'variable_percent',
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

/**
 * What a discount touches, for deciding which discounts may stack: an item
 * discount (items, categories, modifiers, deals), a whole-order discount, or a
 * delivery discount.
 */
export const DISCOUNT_COMBINE_CLASS_VALUES = [
	'item',
	'order',
	'delivery',
] as const
export type DiscountCombineClass =
	(typeof DISCOUNT_COMBINE_CLASS_VALUES)[number]

export const DISCOUNT_TIER_BASIS_VALUES = ['spend', 'quantity'] as const
export type DiscountTierBasis = (typeof DISCOUNT_TIER_BASIS_VALUES)[number]

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
export const DISCOUNT_MAX_TARGET_MODIFIER_GROUPS = 50
export const DISCOUNT_MAX_TARGET_MODIFIER_OPTIONS = 200
export const DISCOUNT_MAX_TIER_STEPS = 10
export const DISCOUNT_MAX_BUNDLE_SLOTS = 8
/** Units in one bundle, across all its slots. */
export const DISCOUNT_MAX_BUNDLE_UNITS = 20

/**
 * 3 to 24 characters: letters, digits and dashes, at least 3 of them letters
 * or digits (`---` would normalize to nothing). Matched case-insensitively.
 */
export const DISCOUNT_CODE_PATTERN =
	/^(?=(?:-*[A-Za-z0-9]){3})[A-Za-z0-9-]{3,24}$/

/**
 * What a phone keyboard or a paste adds that the guest never meant: invisible
 * format characters (bidi marks, zero-width spaces) go, and Arabic-Indic and
 * Eastern Arabic digits become ASCII, so `SAVE١٠` is `SAVE10`.
 */
export function foldDiscountCodeCharacters(value: string): string {
	return value
		.replace(/\p{Cf}/gu, '')
		.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
}

/** Upper case, no spaces or dashes: what is stored, compared and rate limited. */
export function normalizeDiscountCode(value: string): string {
	return foldDiscountCodeCharacters(value)
		.replace(/\p{Cf}/gu, '')
		.replace(/[\s-]+/g, '')
		.toUpperCase()
}

const catalogIdSchema = z.string().min(1).max(100)
const minorSchema = z.number().int().min(0).max(DISCOUNT_MAX_MINOR)
const localDateTimeSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM')
	.refine((value) => {
		// Rejects 2026-02-31 and 25:99, which the pattern alone lets through.
		const ms = Date.parse(`${value}:00Z`)
		return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value)
	}, 'Not a real date and time')
const timeOfDaySchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')

export const discountTargetSchema = z
	.object({
		/**
		 * `modifiers` discounts the choices on an item (toppings, sauces) rather
		 * than the item. Then `itemIds` and `categoryIds` narrow which items'
		 * choices count (both empty: any item), and the two modifier lists say
		 * which choices are discounted.
		 */
		scope: z.enum(['order', 'items', 'categories', 'modifiers']),
		itemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		categoryIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_CATEGORIES),
		excludeItemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		excludeCategoryIds: z
			.array(catalogIdSchema)
			.max(DISCOUNT_MAX_TARGET_CATEGORIES),
		/** Modifier groups whose every choice is discounted. */
		modifierGroupIds: z
			.array(catalogIdSchema)
			.max(DISCOUNT_MAX_TARGET_MODIFIER_GROUPS)
			.optional(),
		/** Single modifier options, whichever group they sit in. */
		modifierOptionIds: z
			.array(catalogIdSchema)
			.max(DISCOUNT_MAX_TARGET_MODIFIER_OPTIONS)
			.optional(),
		/**
		 * Only lines whose variant matches ("any large pizza"). Items,
		 * categories and modifiers scope.
		 */
		variants: discountVariantFiltersSchema.optional(),
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

/** A group of items, by item or by category. At least one of the two. */
export const discountItemSetSchema = z
	.object({
		quantity: quantityNumber,
		itemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		categoryIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_CATEGORIES),
		/** Only these variants count ("Size: Large"). */
		variants: discountVariantFiltersSchema.optional(),
	})
	.strict()
	.refine((set) => set.itemIds.length > 0 || set.categoryIds.length > 0, {
		message: 'Choose at least one item or category',
		path: ['itemIds'],
	})
export type DiscountItemSet = z.infer<typeof discountItemSetSchema>

/**
 * The buy side of a buy-get rule: a quantity of the group ("buy 2 burgers") or
 * an amount spent on it ("spend $30 on burgers"), never both.
 */
export const discountBuySetSchema = z
	.object({
		quantity: quantityNumber.optional(),
		/** Spent on the group, in minor units of the discount's currency. */
		spendMinor: minorSchema.min(1).optional(),
		itemIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_ITEMS),
		categoryIds: z.array(catalogIdSchema).max(DISCOUNT_MAX_TARGET_CATEGORIES),
		variants: discountVariantFiltersSchema.optional(),
	})
	.strict()
	.refine((set) => set.itemIds.length > 0 || set.categoryIds.length > 0, {
		message: 'Choose at least one item or category',
		path: ['itemIds'],
	})
	.refine(
		(set) => (set.quantity === undefined) !== (set.spendMinor === undefined),
		{
			message: 'Set a quantity or an amount to spend',
			path: ['quantity'],
		},
	)
export type DiscountBuySet = z.infer<typeof discountBuySetSchema>

/**
 * A ladder: the more the customer spends or buys, the bigger the discount
 * ("spend $30 get $5, spend $50 get 15%"). Each step carries the value for
 * its tier, in place of the discount's own value. An amount step is one amount
 * for all the matching items together, never an amount per item.
 */
export const discountTiersSchema = z
	.object({
		basis: z.enum(DISCOUNT_TIER_BASIS_VALUES),
		steps: z
			.array(
				z
					.object({
						/** Minor units for `spend`, a count of items for `quantity`. */
						at: z.number().int().min(1).max(DISCOUNT_MAX_MINOR),
						percentBp: z.number().int().min(1).max(10_000).nullable(),
						amountMinor: minorSchema.min(1).nullable(),
					})
					.strict(),
			)
			.min(1)
			.max(DISCOUNT_MAX_TIER_STEPS),
	})
	.strict()
export type DiscountTiers = z.infer<typeof discountTiersSchema>

export const discountQuantityRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }).strict(),
	z.object({ kind: z.literal('exact'), quantity: quantityNumber }).strict(),
	z.object({ kind: z.literal('minimum'), quantity: quantityNumber }).strict(),
	/**
	 * Modifier discounts only: the first `quantity` matching choices on each
	 * unit of an item, dearest first ("2 toppings free on every pizza").
	 */
	z.object({ kind: z.literal('per_item'), quantity: quantityNumber }).strict(),
	z
		.object({
			kind: z.literal('bogo'),
			buyQuantity: quantityNumber,
			getQuantity: quantityNumber,
		})
		.strict(),
	/**
	 * Buy from one group, get from another ("buy a burger, get fries free").
	 * The bought units are used up by the pair, so two burgers earn two
	 * discounted fries, not one. The discount value applies to the get units.
	 */
	z
		.object({
			kind: z.literal('buy_get'),
			buy: discountBuySetSchema,
			get: discountItemSetSchema,
		})
		.strict(),
	/**
	 * A meal deal: one or more slots that together form a bundle, repeated as
	 * often as the cart allows ("any 2 pizzas, a side and a drink"). The value
	 * applies to the bundle as a whole.
	 */
	z
		.object({
			kind: z.literal('bundle'),
			slots: z
				.array(discountItemSetSchema)
				.min(1)
				.max(DISCOUNT_MAX_BUNDLE_SLOTS),
		})
		.strict()
		.refine(
			(rule) =>
				rule.slots.reduce((sum, slot) => sum + slot.quantity, 0) <=
				DISCOUNT_MAX_BUNDLE_UNITS,
			{ message: 'A bundle holds at most 20 items', path: ['slots'] },
		),
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
		/**
		 * `name` in every website language, the default included. Missing or
		 * empty: `name` is used everywhere.
		 */
		nameI18n: discountLocalizedTextSchema(DISCOUNT_NAME_MAX).optional(),
		/** `description` in every website language. */
		descriptionI18n: discountLocalizedTextSchema(
			DISCOUNT_DESCRIPTION_MAX,
		).optional(),
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
		locationIds: z.array(catalogIdSchema).min(1).max(200).nullable(),
		channels: z.array(z.enum(DISCOUNT_CHANNEL_VALUES)).min(1),
		fulfillments: z.array(z.enum(DISCOUNT_FULFILLMENT_VALUES)).min(1),
		includeDrops: z.boolean(),
		schedule: z
			.array(discountScheduleWindowSchema)
			.min(1)
			.max(DISCOUNT_MAX_SCHEDULE_WINDOWS)
			.nullable(),
		/** Local date-times in each location's time zone. */
		startsAt: localDateTimeSchema.nullable(),
		endsAt: localDateTimeSchema.nullable(),
		eligibility: z.enum(DISCOUNT_ELIGIBILITY_VALUES),
		totalLimit: z.number().int().min(1).max(1_000_000).nullable(),
		perCustomerLimit: discountPerCustomerLimitSchema.nullable(),
		combinable: z.boolean(),
		/**
		 * Which kinds of discount this one may stack with. Missing: `combinable`
		 * decides (all kinds, or none). Two discounts stack only if each allows
		 * the other's kind.
		 */
		combinesWith: z
			.array(z.enum(DISCOUNT_COMBINE_CLASS_VALUES))
			.max(DISCOUNT_COMBINE_CLASS_VALUES.length)
			.optional(),
		/** Spend or quantity ladder. Percent and fixed discounts only. */
		tiers: discountTiersSchema.nullable().optional(),
		/**
		 * Free delivery only: it applies when the fee is no more than this, so a
		 * long-distance fee isn't waived by "free delivery".
		 */
		maxDeliveryFeeMinor: minorSchema.min(1).nullable().optional(),
		/** Lower runs first and wins ties. */
		priority: z.number().int().min(0).max(1000),
		promoteOnMenu: z.boolean(),
		requireApproval: z.boolean(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const issue = (path: string, message: string) =>
			ctx.addIssue({ code: 'custom', path: [path], message })
		const variableAmount = value.valueType === 'variable_amount'
		const variablePercent = value.valueType === 'variable_percent'
		if ((variableAmount || variablePercent) && value.application !== 'manual') {
			issue('application', 'A variable discount is entered at the till')
		}
		const tiered = Boolean(value.tiers)
		if (value.valueType === 'percent') {
			if (value.percentBp === null && !tiered) {
				issue('percentBp', 'Enter a percentage')
			}
			if (value.percentBp !== null && tiered) {
				issue('percentBp', 'Each tier has its own percentage')
			}
			if (value.amountMinor !== null) issue('amountMinor', 'Not used')
		} else if (variablePercent) {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.amountMinor !== null) issue('amountMinor', 'Not used')
			// A cap or a minimum is entered in a currency, so it may carry one.
			if (
				value.currency !== null &&
				value.minSubtotalMinor === null &&
				value.maxDiscountMinor === null
			) {
				issue('currency', 'Not used')
			}
		} else if (value.valueType === 'fixed') {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.maxDiscountMinor !== null) {
				issue('maxDiscountMinor', 'A maximum only applies to percentages')
			}
			if (value.amountMinor === null && !tiered) {
				issue('amountMinor', 'Enter an amount')
			}
			if (value.amountMinor !== null && tiered) {
				issue('amountMinor', 'Each tier has its own amount')
			}
			if (value.currency === null) issue('currency', 'Choose a currency')
		} else if (value.valueType === 'fixed_price') {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.maxDiscountMinor !== null) {
				issue('maxDiscountMinor', 'A maximum only applies to percentages')
			}
			if (value.amountMinor === null) issue('amountMinor', 'Enter a price')
			if (value.currency === null) issue('currency', 'Choose a currency')
		} else if (variableAmount) {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.amountMinor !== null) issue('amountMinor', 'Not used')
			if (value.currency === null) issue('currency', 'Choose a currency')
		} else {
			if (value.percentBp !== null) issue('percentBp', 'Not used')
			if (value.amountMinor !== null) issue('amountMinor', 'Not used')
			if (value.maxDiscountMinor !== null) {
				issue('maxDiscountMinor', 'A maximum only applies to percentages')
			}
		}
		// A cap or a minimum is a number of minor units, so it needs the
		// currency it was entered in, or it would be read in another's units.
		if (
			(value.maxDiscountMinor !== null || value.minSubtotalMinor !== null) &&
			value.currency === null
		) {
			issue('currency', 'Choose a currency')
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
		const setRule =
			value.quantityRule.kind === 'buy_get' ||
			value.quantityRule.kind === 'bundle'
		const modifierChoices =
			(value.target.modifierGroupIds?.length ?? 0) +
			(value.target.modifierOptionIds?.length ?? 0)
		if (value.target.scope === 'modifiers') {
			if (modifierChoices === 0) {
				issue('target', 'Choose at least one modifier group or option')
			}
			if (
				value.quantityRule.kind !== 'none' &&
				value.quantityRule.kind !== 'per_item'
			) {
				issue(
					'quantityRule',
					'Modifier choices are all discounted, or the first few on each item',
				)
			}
		} else {
			if (value.quantityRule.kind === 'per_item') {
				issue('quantityRule', 'The first few per item needs modifier choices')
			}
			if (modifierChoices > 0) {
				issue('target', 'Modifier choices only apply to a modifier discount')
			}
		}
		if (
			value.target.scope === 'order' &&
			value.maxDiscountedUnits !== null &&
			!setRule
		) {
			issue('maxDiscountedUnits', 'Only applies to items or categories')
		}
		if (value.quantityRule.kind === 'bogo' && value.target.scope === 'order') {
			issue('quantityRule', 'Buy one get one needs items or categories')
		}
		if (setRule) {
			// The rule names its own items, so a second target would be a
			// competing answer to "which items". Exclusions still apply.
			if (value.target.scope !== 'order') {
				issue('target', 'The items are chosen in the rule')
			}
			if (value.application === 'manual') {
				issue('application', 'A meal deal applies automatically or with a code')
			}
		}
		if (value.valueType === 'fixed_price') {
			if (value.application === 'manual') {
				issue('application', 'A set price applies automatically or with a code')
			}
			if (
				!setRule &&
				value.quantityRule.kind !== 'none' &&
				value.quantityRule.kind !== 'per_item'
			) {
				issue('quantityRule', 'A set price applies to every matching item')
			}
			if (!setRule && value.target.scope === 'order') {
				issue('target', 'A set price needs items, categories or a bundle')
			}
		}
		// Variant filters narrow items, categories and modifiers; on the whole
		// order they would be ignored.
		if (
			(value.target.variants?.length ?? 0) > 0 &&
			value.target.scope === 'order'
		) {
			issue('target', 'Options narrow items, categories or modifier choices')
		}

		// A spend threshold is an amount of money, so it needs its currency.
		if (
			value.quantityRule.kind === 'buy_get' &&
			value.quantityRule.buy.spendMinor !== undefined &&
			value.currency === null
		) {
			issue('currency', 'Choose a currency')
		}

		if (value.tiers) {
			const { basis, steps } = value.tiers
			if (value.valueType !== 'percent' && value.valueType !== 'fixed') {
				issue('tiers', 'Tiers set a percentage or an amount off')
			}
			if (value.application === 'manual') {
				issue('tiers', 'Tiers apply automatically or with a code')
			}
			if (
				setRule ||
				value.target.scope === 'modifiers' ||
				value.quantityRule.kind !== 'none'
			) {
				issue('tiers', 'Tiers go with a plain item or order discount')
			}
			if (basis === 'spend' && value.currency === null) {
				issue('currency', 'Choose a currency')
			}
			steps.forEach((step, index) => {
				if (index > 0 && step.at <= steps[index - 1]!.at) {
					issue('tiers', 'Tiers must go up')
				}
				if (value.valueType === 'percent') {
					if (step.percentBp === null || step.amountMinor !== null) {
						issue('tiers', 'Each tier needs a percentage')
					}
				} else if (value.valueType === 'fixed') {
					if (step.amountMinor === null || step.percentBp !== null) {
						issue('tiers', 'Each tier needs an amount')
					}
				}
			})
		}

		if (value.maxDeliveryFeeMinor != null) {
			if (value.valueType !== 'free_delivery') {
				issue('maxDeliveryFeeMinor', 'Only free delivery has a fee limit')
			}
			if (value.currency === null) issue('currency', 'Choose a currency')
		}
		if (
			value.combinesWith &&
			new Set(value.combinesWith).size !== value.combinesWith.length
		) {
			issue('combinesWith', 'Each kind once')
		}

		if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
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

/** The kinds of discount this one may stack with. */
export function combinesWithOf(
	discount: Pick<DiscountDefinition, 'combinable' | 'combinesWith'>,
): readonly DiscountCombineClass[] {
	return (
		discount.combinesWith ??
		(discount.combinable ? DISCOUNT_COMBINE_CLASS_VALUES : [])
	)
}

/** What this discount touches, which decides who it may stack with. */
export function discountClassOf(
	discount: Pick<DiscountDefinition, 'valueType' | 'target' | 'quantityRule'>,
): DiscountCombineClass {
	if (discount.valueType === 'free_delivery') return 'delivery'
	const dealRule =
		discount.quantityRule.kind === 'buy_get' ||
		discount.quantityRule.kind === 'bundle'
	return discount.target.scope === 'order' && !dealRule ? 'order' : 'item'
}
