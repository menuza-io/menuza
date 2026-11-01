import { discountPromotionLive } from '@repo/discounts'

/**
 * Which promoted discounts the menu shows, and where. The App sends every
 * promoted offer of the organization; the menu keeps the ones that work at the
 * location, now (in its time zone) and for an order type this app can start,
 * and badges an item only where the region would discount it. These are the
 * same rules as the website menu (`apps/sites/src/lib/ordering/offers.ts`).
 * Display only: the region decides what an order actually gets.
 */

export type OfferMode = 'pickup' | 'delivery' | 'dine_in'

/** The fields of a promotion these helpers read. */
export type OfferPromotion = {
	scope: 'order' | 'items' | 'categories'
	itemIds: readonly string[]
	categoryIds: readonly string[]
	itemBadges: boolean
	locationIds: readonly string[] | null
	fulfillments: readonly OfferMode[] | null
	startsAt: string | null
	endsAt: string | null
	schedule?: readonly {
		day: number
		start: string
		end: string
	}[]
	excludeItemIds?: readonly string[]
	excludeCategoryIds?: readonly string[]
}

/** Where and for which order types the offers are looked at. */
export type OfferScope = {
	locationId: string | null
	timeZone: string
	modes: readonly OfferMode[]
}

export const DEFAULT_OFFER_SCOPE: OfferScope = {
	locationId: null,
	timeZone: 'UTC',
	modes: ['pickup'],
}

export const MAX_ITEM_BADGES = 2
export const MAX_BANNER_OFFERS = 3

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
 * of the scope's order types.
 */
export function promotionsForScope<T extends OfferPromotion>(
	promotions: readonly T[],
	scope: OfferScope,
	now: Date = new Date(),
): T[] {
	const stamp = localStamp(scope.timeZone, now)
	return promotions.filter((promotion) => {
		if (
			promotion.locationIds &&
			(!scope.locationId || !promotion.locationIds.includes(scope.locationId))
		) {
			return false
		}
		if (!isPromotionLive(promotion, stamp)) return false
		const fulfillments = promotion.fulfillments
		return (
			!fulfillments || fulfillments.some((mode) => scope.modes.includes(mode))
		)
	})
}

/**
 * The offers badged on an item, at most two. `directCategoryIds` is the item's
 * own category only: the region matches a category target by the item's direct
 * category, so a "Pizza" offer must not badge an item listed under Pizza > Veg.
 */
export function offersForItem<T extends OfferPromotion>(
	promotions: readonly T[],
	itemId: string,
	directCategoryIds: readonly string[],
	max = MAX_ITEM_BADGES,
	options?: { excludeFromDiscounts?: boolean },
): T[] {
	const matches: T[] = []
	if (options?.excludeFromDiscounts) return matches
	for (const promotion of promotions) {
		if (!promotion.itemBadges) continue
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
	promotions: readonly T[],
	max = MAX_BANNER_OFFERS,
): { shown: T[]; more: number } {
	return {
		shown: promotions.slice(0, max),
		more: Math.max(0, promotions.length - max),
	}
}
