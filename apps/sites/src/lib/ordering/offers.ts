import { discountPromotionLive, localizedDiscountText } from '@repo/discounts'

/**
 * Which promoted discounts the menu page shows, and where. The App sends every
 * promoted offer of the organization; this page keeps the ones that work at
 * the active location, now, and for the order type, and badges an item only
 * where the region would discount it. Display only: the region decides what
 * an order actually gets.
 */

/** The fields of `PublicMenuPromotion` (`~/lib/org`) these helpers read. */
export type OfferPromotion = {
	scope: 'order' | 'items' | 'categories'
	itemIds: string[]
	categoryIds: string[]
	itemBadges?: boolean
	locationIds?: string[] | null
	fulfillments?: OfferMode[]
	startsAt?: string | null
	endsAt?: string | null
	schedule?: readonly {
		day: number
		start: string
		end: string
	}[]
	excludeItemIds?: string[]
	excludeCategoryIds?: string[]
}

export type OfferMode = 'pickup' | 'delivery' | 'dine_in'

/** A wall-clock "YYYY-MM-DDTHH:mm" as shown by a clock in `timeZone`. */
export function localStamp(timeZone: string, date: Date = new Date()): string {
	let parts: Record<string, string> = {}
	try {
		parts = Object.fromEntries(
			new Intl.DateTimeFormat('en-US', {
				timeZone,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
				.formatToParts(date)
				.map((part) => [part.type, part.value]),
		)
	} catch {
		// An unknown zone: fall back to UTC rather than hiding or showing all.
		return date.toISOString().slice(0, 16)
	}
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function isPromotionLive(
	promotion: Pick<OfferPromotion, 'startsAt' | 'endsAt' | 'schedule'>,
	stamp: string,
): boolean {
	return discountPromotionLive(promotion, stamp)
}

/**
 * The promotions that can apply at this location right now for at least one
 * of `modes` (the order types this page can place; the banner narrows to the
 * current one in the browser).
 */
export function promotionsForLocation<T extends OfferPromotion>(
	promotions: T[],
	options: {
		locationId: string | null | undefined
		timeZone: string
		modes: OfferMode[]
		now?: Date
	},
): T[] {
	const stamp = localStamp(options.timeZone, options.now)
	return promotions.filter((promotion) => {
		if (
			promotion.locationIds &&
			(!options.locationId ||
				!promotion.locationIds.includes(options.locationId))
		) {
			return false
		}
		if (!isPromotionLive(promotion, stamp)) return false
		const fulfillments = promotion.fulfillments
		return (
			!fulfillments || fulfillments.some((mode) => options.modes.includes(mode))
		)
	})
}

/** Whether an offer works for the order type the customer has chosen. */
export function worksForMode(
	promotion: Pick<OfferPromotion, 'fulfillments'>,
	mode: OfferMode,
): boolean {
	return !promotion.fulfillments || promotion.fulfillments.includes(mode)
}

export const MAX_ITEM_BADGES = 2
export const MAX_BANNER_OFFERS = 3

/**
 * The offers badged on an item, at most two. `directCategoryIds` is the item's
 * own category only: the region matches a category target by the item's direct
 * category (`collectMenuCategories` in `@repo/common/restaurant-orders`), so a
 * "Pizza" offer must not badge an item listed under Pizza > Veg.
 */
export function offersForItem<T extends OfferPromotion>(
	promotions: T[],
	itemId: string,
	directCategoryIds: string[],
	max = MAX_ITEM_BADGES,
	options?: { excludeFromDiscounts?: boolean },
): T[] {
	const matches: T[] = []
	if (options?.excludeFromDiscounts) return matches
	for (const promotion of promotions) {
		if (promotion.itemBadges === false) continue
		const excluded =
			promotion.excludeItemIds?.includes(itemId) ||
			promotion.excludeCategoryIds?.some((id) => directCategoryIds.includes(id))
		if (excluded) continue
		const covers =
			promotion.scope === 'order' ||
			promotion.itemIds.includes(itemId) ||
			promotion.categoryIds.some((id) => directCategoryIds.includes(id))
		if (!covers) continue
		matches.push(promotion)
		if (matches.length >= max) break
	}
	return matches
}

/** The banner's offers and how many more there are. */
export function bannerOffers<T>(
	promotions: T[],
	max = MAX_BANNER_OFFERS,
): { shown: T[]; more: number } {
	return {
		shown: promotions.slice(0, max),
		more: Math.max(0, promotions.length - max),
	}
}

/** The guest-facing text of a promotion, as `PublicMenuPromotion` (`~/lib/org`) carries it. */
export type PromotionText = {
	name: string
	description: string | null
	/** Per website language; missing (older App or never translated): `name` only. */
	nameI18n?: Record<string, string>
	descriptionI18n?: Record<string, string>
}

/**
 * The promotion with its name and description in the page language: the
 * guest's language, then the site's default language, then the text the
 * operator typed. A description shows only when there is one in some form.
 */
export function localizePromotion<T extends PromotionText>(
	promotion: T,
	locale: string | null | undefined,
	defaultLocale?: string | null,
): T {
	const description = promotion.description ?? ''
	const localizedDescription = localizedDiscountText(
		promotion.descriptionI18n,
		description,
		locale,
		defaultLocale,
	)
	return {
		...promotion,
		name: localizedDiscountText(
			promotion.nameI18n,
			promotion.name,
			locale,
			defaultLocale,
		),
		description: localizedDescription || null,
	}
}
