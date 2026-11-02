import {
	DISCOUNT_FULFILLMENT_VALUES,
	type DiscountFulfillment,
	type DiscountRecord,
} from '@repo/discounts'

/**
 * What the public menu shows of a discount. A coupon code is included only
 * for a code discount the operator chose to promote (Promote on menu): the
 * promotion is the opt-in. Everything else is checked when typed.
 */
export type PublicMenuPromotion = {
	id: string
	/** In the website's default language. */
	name: string
	description: string | null
	/**
	 * The name and description in each website language, the default
	 * included, so the menu can show the visitor's (`localizedDiscountText`).
	 * Left out when there are none.
	 */
	nameI18n?: Record<string, string>
	descriptionI18n?: Record<string, string>
	valueType: 'percent' | 'fixed' | 'fixed_price' | 'free_delivery'
	percentBp: number | null
	amountMinor: number | null
	currency: string | null
	/** `order` badges every item; otherwise the item and category ids decide. */
	scope: 'order' | 'items' | 'categories'
	itemIds: string[]
	categoryIds: string[]
	/**
	 * Show the discount's own name instead of a value badge. A set price, a deal,
	 * a modifier discount, a ladder or an option-limited discount has no single
	 * "20% off" to put on an item.
	 */
	showName: boolean
	/**
	 * Put a badge on the items it covers. False for what has no per-item value
	 * (free delivery, an offer for some order types, an order-wide condition):
	 * the banner says it instead.
	 */
	itemBadges: boolean
	/**
	 * A plain percentage, or an amount off each item, with no condition at all:
	 * the menu may show a was/now price on the items it covers (only when it is
	 * the one offer that covers the item; see `menuItemSalePrice`).
	 */
	itemPrice: boolean
	/** Null means every location. The menu shows the offer only at these. */
	locationIds: string[] | null
	/** Order types the offer works for. */
	fulfillments: DiscountFulfillment[]
	/**
	 * Local wall-clock start and end ("2026-11-01T09:00") in each location's
	 * time zone. The server only trims by a day of slack; the menu page checks
	 * the exact time in the location's zone.
	 */
	startsAt: string | null
	endsAt: string | null
	/** Weekly hours in the location's zone; the menu page filters on these. */
	schedule: DiscountRecord['schedule']
	/**
	 * The one unlimited code of a promoted code discount. Null when there is
	 * no code, more than one, or the only code has a use limit.
	 */
	code: string | null
	excludeItemIds: string[]
	excludeCategoryIds: string[]
}

function nonEmpty(
	map: Record<string, string> | undefined,
): map is Record<string, string> {
	return map !== undefined && Object.keys(map).length > 0
}

function unique(ids: readonly string[]): string[] {
	return [...new Set(ids)]
}

/**
 * The menu entry for a discount, or null when the menu can't show it (a
 * variable discount is keyed in at the till).
 *
 * A deal's items are the ones its groups name, so they get the badge. A
 * modifier discount badges the items it is limited to, or only the banner
 * when it covers every item.
 */
export function publicPromotionFor(
	discount: DiscountRecord,
	options: { code?: string | null } = {},
): PublicMenuPromotion | null {
	const { valueType, quantityRule: rule, target } = discount
	if (valueType === 'variable_amount' || valueType === 'variable_percent') {
		return null
	}
	const sets =
		rule.kind === 'buy_get'
			? [rule.buy, rule.get]
			: rule.kind === 'bundle'
				? rule.slots
				: []
	const deal = sets.length > 0
	const modifiers = target.scope === 'modifiers'
	const itemIds = deal
		? unique(sets.flatMap((set) => set.itemIds))
		: target.itemIds
	const categoryIds = deal
		? unique(sets.flatMap((set) => set.categoryIds))
		: target.categoryIds
	const freeDelivery = valueType === 'free_delivery'
	const limitedFulfillment = !DISCOUNT_FULFILLMENT_VALUES.every((value) =>
		discount.fulfillments.includes(value),
	)
	// Only a plain, unconditional value reads the same on every item as in the
	// banner ("10% off"). Anything with a condition shows the discount's name,
	// and so does a percentage with a cap: "20% off up to $5" is not "20% off".
	const conditional =
		deal ||
		modifiers ||
		freeDelivery ||
		valueType === 'fixed_price' ||
		Boolean(discount.tiers) ||
		(target.variants?.length ?? 0) > 0 ||
		rule.kind !== 'none' ||
		discount.minSubtotalMinor !== null ||
		discount.schedule !== null ||
		discount.eligibility !== 'everyone' ||
		discount.application === 'code' ||
		discount.requirement !== null ||
		discount.maxDiscountedUnits !== null ||
		(valueType === 'percent' && discount.maxDiscountMinor !== null)
	const orderWide = !deal && target.scope === 'order'
	const excluding =
		target.excludeItemIds.length > 0 || target.excludeCategoryIds.length > 0
	const itemBadges =
		!freeDelivery &&
		!limitedFulfillment &&
		// An order-wide amount off is taken once, so "$5 off" on every item
		// would promise $5 per item.
		!(orderWide && (conditional || excluding || valueType === 'fixed'))
	return {
		id: discount.id,
		name: discount.name,
		description: discount.description,
		...(nonEmpty(discount.nameI18n) ? { nameI18n: discount.nameI18n } : {}),
		...(nonEmpty(discount.descriptionI18n)
			? { descriptionI18n: discount.descriptionI18n }
			: {}),
		valueType,
		percentBp: discount.tiers ? null : discount.percentBp,
		amountMinor: discount.tiers ? null : discount.amountMinor,
		currency: discount.currency,
		scope: deal || target.scope === 'modifiers' ? 'items' : target.scope,
		itemIds,
		categoryIds,
		showName: conditional,
		itemBadges,
		itemPrice:
			itemBadges &&
			!conditional &&
			((valueType === 'percent' && discount.percentBp !== null) ||
				(valueType === 'fixed' &&
					discount.amountMinor !== null &&
					target.scope !== 'order')),
		locationIds: discount.locationIds,
		fulfillments: discount.fulfillments,
		startsAt: discount.startsAt,
		endsAt: discount.endsAt,
		schedule: discount.schedule,
		code: discount.application === 'code' ? (options.code ?? null) : null,
		excludeItemIds: target.excludeItemIds,
		excludeCategoryIds: target.excludeCategoryIds,
	}
}
