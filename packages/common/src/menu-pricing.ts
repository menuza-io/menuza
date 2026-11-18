import { z } from 'zod'

/**
 * Menu price resolution (#412, #388): the one function every channel uses to
 * turn a dish or option into the price a guest pays.
 *
 * Order, for a dish:
 *   1. A fixed per-location price override (above zero) wins outright: no
 *      order-type price, no rule.
 *   2. Otherwise the price for the order type (dine-in, pickup, delivery) when
 *      one is set, else the base price. A chosen variation has its own price
 *      and ignores the dish's order-type prices.
 *   3. Then the first pricing rule that covers the dish at this location, unless
 *      the price from step 2 is inside the rule's excluded range.
 *
 * Options take steps 1 and 2 only: rules cover dishes, because one option is
 * shared by many dishes and would otherwise cost different amounts per dish.
 *
 * Callers: the region's order engine (quote, placement, QR table rounds, the
 * till review), Station, the Sites menu and cart, the customer app and the
 * phone agent's menu. A later per-delivery-app markup (#204) plugs in here.
 *
 * Prices are major units (the catalog stores 12.5 for 12.50); the arithmetic
 * runs in minor units (cents, halalas) so rounding is exact.
 */

export const MENU_ORDER_TYPES = ['dine_in', 'pickup', 'delivery'] as const
export type MenuOrderType = (typeof MENU_ORDER_TYPES)[number]

/** Optional price per order type, in major units. A missing key: base price. */
export type OrderTypePrices = Partial<Record<MenuOrderType, number>>

/** Highest price accepted anywhere in the menu (major units). */
export const MENU_PRICE_MAX = 999_999.99

/**
 * The pricing order type for any channel's word. Takeaway and drive-through
 * (Station, #404) price as pickup; QR table rounds and tabs are dine-in.
 */
export function menuOrderTypeFor(
	value: string | null | undefined,
): MenuOrderType {
	if (value === 'dine_in') return 'dine_in'
	if (value === 'delivery') return 'delivery'
	return 'pickup'
}

function isPrice(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MENU_PRICE_MAX
	)
}

/**
 * Reads stored or published order-type prices defensively: a JSON string or an
 * object; unknown keys and bad numbers are dropped. Null when none is set.
 */
export function parseOrderTypePrices(raw: unknown): OrderTypePrices | null {
	let value: unknown = raw
	if (typeof raw === 'string') {
		if (!raw.trim()) return null
		try {
			value = JSON.parse(raw)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	const out: OrderTypePrices = {}
	for (const type of MENU_ORDER_TYPES) {
		const price = record[type]
		if (isPrice(price)) out[type] = price
	}
	return Object.keys(out).length > 0 ? out : null
}

/** Storage form: null when nothing is set, so an empty object never lingers. */
export function serializeOrderTypePrices(
	prices: OrderTypePrices | null | undefined,
): string | null {
	const parsed = parseOrderTypePrices(prices ?? null)
	return parsed ? JSON.stringify(parsed) : null
}

export const orderTypePricesSchema = z
	.object({
		dine_in: z.number().finite().min(0).max(MENU_PRICE_MAX).optional(),
		pickup: z.number().finite().min(0).max(MENU_PRICE_MAX).optional(),
		delivery: z.number().finite().min(0).max(MENU_PRICE_MAX).optional(),
	})
	.strict()

// ---------------------------------------------------------------------------
// Pricing rules (#388)
// ---------------------------------------------------------------------------

export const PRICING_ROUNDING_MODES = ['none', 'decimals', 'amount'] as const
export type PricingRoundingMode = (typeof PRICING_ROUNDING_MODES)[number]

export type PricingRounding =
	| { mode: 'none' }
	/** Round up to whole units (0) or tenths (1). */
	| { mode: 'decimals'; decimals: 0 | 1 }
	/** Round up to a multiple of this many minor units (25 is 0.25). */
	| { mode: 'amount'; amountMinor: number }

/** Lowest and highest percentage a rule may apply, in basis points. */
export const PRICING_RULE_MIN_BP = -9_000
export const PRICING_RULE_MAX_BP = 50_000
/** Largest round-up step, in minor units (100.00). */
export const PRICING_ROUNDING_MAX_MINOR = 10_000

/**
 * A rule as the App publishes it. Menus are already expanded to their category
 * ids (and every category to its subcategories), so a dish added to a covered
 * category later is covered too.
 */
export type MenuPricingRule = {
	id: string
	percentBp: number
	/** True: every dish. Otherwise only dishes listed in one of `categoryIds`. */
	allDishes: boolean
	categoryIds: string[]
	/** Empty: every location. */
	locationIds: string[]
	rounding: PricingRounding
	/** Prices in this range (major units, inclusive) are left alone. */
	excludeMinPrice?: number | null
	excludeMaxPrice?: number | null
	/** ISO times; a missing start applies at once, a missing end never ends. */
	startsAt?: string | null
	endsAt?: string | null
}

const roundingSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('none') }),
	z.object({
		mode: z.literal('decimals'),
		decimals: z.union([z.literal(0), z.literal(1)]),
	}),
	z.object({
		mode: z.literal('amount'),
		amountMinor: z.number().int().min(1).max(PRICING_ROUNDING_MAX_MINOR),
	}),
])

export const menuPricingRuleSchema = z
	.object({
		id: z.string().min(1),
		percentBp: z
			.number()
			.int()
			.min(PRICING_RULE_MIN_BP)
			.max(PRICING_RULE_MAX_BP),
		allDishes: z.boolean(),
		categoryIds: z.array(z.string()).max(2000),
		locationIds: z.array(z.string()).max(500),
		rounding: roundingSchema,
		excludeMinPrice: z.number().finite().min(0).nullable().optional(),
		excludeMaxPrice: z.number().finite().min(0).nullable().optional(),
		startsAt: z.string().nullable().optional(),
		endsAt: z.string().nullable().optional(),
	})
	.loose()

/**
 * Published rules, read defensively: a malformed rule is dropped rather than
 * failing the whole menu (an older or newer App may publish other fields).
 */
export function parseMenuPricingRules(raw: unknown): MenuPricingRule[] {
	if (!Array.isArray(raw)) return []
	const rules: MenuPricingRule[] = []
	for (const entry of raw) {
		const parsed = menuPricingRuleSchema.safeParse(entry)
		if (parsed.success) rules.push(parsed.data as MenuPricingRule)
	}
	return rules
}

/** Major units to integer minor units (the catalog has two decimals). */
export function priceToMinor(price: number): number {
	return Math.round(price * 100)
}

export function minorToPrice(minor: number): number {
	return minor / 100
}

/**
 * Applies a percentage to a price in minor units with the rule's rounding.
 * Exact integer arithmetic: `none` rounds half up to the minor unit, the other
 * modes always round up to the step. Never below zero.
 */
export function applyPercentWithRounding(
	priceMinor: number,
	percentBp: number,
	rounding: PricingRounding,
): number {
	const scaled = Math.round(priceMinor) * (10_000 + percentBp)
	if (scaled <= 0) return 0
	if (rounding.mode === 'none') return Math.floor((scaled + 5_000) / 10_000)
	const step =
		rounding.mode === 'decimals'
			? rounding.decimals === 0
				? 100
				: 10
			: Math.max(1, Math.round(rounding.amountMinor))
	const divisor = 10_000 * step
	let units = Math.floor(scaled / divisor)
	if (units * divisor < scaled) units += 1
	return units * step
}

function inWindow(rule: MenuPricingRule, now: Date): boolean {
	const at = now.getTime()
	if (rule.startsAt) {
		const start = Date.parse(rule.startsAt)
		if (Number.isFinite(start) && at < start) return false
	}
	if (rule.endsAt) {
		const end = Date.parse(rule.endsAt)
		if (Number.isFinite(end) && at >= end) return false
	}
	return true
}

export type PricingRuleScope = {
	locationId?: string | null
	/** Every category the dish is listed under. */
	categoryIds?: readonly string[]
	now?: Date
}

export function ruleCovers(
	rule: MenuPricingRule,
	scope: PricingRuleScope,
): boolean {
	if (!inWindow(rule, scope.now ?? new Date())) return false
	if (rule.locationIds.length > 0) {
		if (!scope.locationId || !rule.locationIds.includes(scope.locationId))
			return false
	}
	if (rule.allDishes) return true
	const categories = scope.categoryIds ?? []
	return categories.some((id) => rule.categoryIds.includes(id))
}

/**
 * The rule that prices a dish: the first in the published order that covers it.
 * The App publishes category and menu rules before "every dish" rules, newest
 * first, so the most specific rule wins and rules never stack.
 */
export function pickPricingRule(
	rules: readonly MenuPricingRule[] | null | undefined,
	scope: PricingRuleScope,
): MenuPricingRule | null {
	for (const rule of rules ?? []) {
		if (ruleCovers(rule, scope)) return rule
	}
	return null
}

/** Whether a price (major units) sits inside the rule's excluded range. */
export function priceExcludedByRule(
	price: number,
	rule: Pick<MenuPricingRule, 'excludeMinPrice' | 'excludeMaxPrice'>,
): boolean {
	const min = rule.excludeMinPrice ?? null
	const max = rule.excludeMaxPrice ?? null
	if (min === null && max === null) return false
	const minor = priceToMinor(price)
	if (min !== null && minor < priceToMinor(min)) return false
	if (max !== null && minor > priceToMinor(max)) return false
	return true
}

/** The price after a rule (major units); unchanged inside the excluded range. */
export function applyPricingRule(
	price: number,
	rule: Pick<
		MenuPricingRule,
		'percentBp' | 'rounding' | 'excludeMinPrice' | 'excludeMaxPrice'
	>,
): number {
	if (priceExcludedByRule(price, rule)) return price
	return minorToPrice(
		applyPercentWithRounding(
			priceToMinor(price),
			rule.percentBp,
			rule.rounding,
		),
	)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type MenuPriceContext = {
	orderType: MenuOrderType
	locationId?: string | null
	rules?: readonly MenuPricingRule[] | null
	now?: Date
}

/** A location override's price: only a price above zero is fixed. */
export function fixedOverridePrice(
	price: number | null | undefined,
): number | null {
	return typeof price === 'number' && Number.isFinite(price) && price > 0
		? price
		: null
}

/** The price of a dish (major units) for this order type, location and time. */
export function resolveMenuItemPrice(
	item: {
		price: number
		orderTypePrices?: unknown
		/** Every category the dish is listed under (for rules). */
		categoryIds?: readonly string[]
	},
	context: MenuPriceContext,
	options: {
		/** The chosen variation's price; its own price replaces the base. */
		variantPrice?: number | null
		/** The location's override price for this dish. */
		overridePrice?: number | null
	} = {},
): number {
	const fixed = fixedOverridePrice(options.overridePrice)
	const hasVariant =
		typeof options.variantPrice === 'number' &&
		Number.isFinite(options.variantPrice)
	if (hasVariant) {
		// A fixed override never priced variations; with one the dish is "fixed"
		// and keeps the variation price unchanged by rules.
		if (fixed !== null) return options.variantPrice as number
	} else if (fixed !== null) {
		return fixed
	}
	const base = hasVariant
		? (options.variantPrice as number)
		: (parseOrderTypePrices(item.orderTypePrices)?.[context.orderType] ??
			item.price)
	const rule = pickPricingRule(context.rules, {
		locationId: context.locationId,
		categoryIds: item.categoryIds,
		now: context.now,
	})
	return rule ? applyPricingRule(base, rule) : base
}

/** The price of an option (major units): override, else order-type, else base. */
export function resolveMenuOptionPrice(
	option: { price: number; orderTypePrices?: unknown },
	context: Pick<MenuPriceContext, 'orderType'>,
	options: { overridePrice?: number | null } = {},
): number {
	const fixed = fixedOverridePrice(options.overridePrice)
	if (fixed !== null) return fixed
	return (
		parseOrderTypePrices(option.orderTypePrices)?.[context.orderType] ??
		option.price
	)
}

/**
 * Whether any published price depends on the order type: a set order-type
 * price somewhere. Clients use it to skip repricing work.
 */
export function hasOrderTypePrices(value: {
	orderTypePrices?: unknown
}): boolean {
	return parseOrderTypePrices(value.orderTypePrices) !== null
}
