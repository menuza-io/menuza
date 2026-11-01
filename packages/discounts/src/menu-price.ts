import { BASIS_POINTS, mulDiv } from './money.ts'

/**
 * A was/now price for a menu item. The menu may show one only when a single,
 * plain discount clearly sets the price: nothing else covers the item that
 * could stack with it or compete for it, and the discount has no condition
 * (cap, minimum, schedule, code, deal, ladder). Everything else stays a badge,
 * and the region still prices every order (`POST /orders/quote`).
 */

/** The fields of a public menu promotion this reads. */
export type MenuPricePromotion = {
	id?: string
	valueType: 'percent' | 'fixed' | 'fixed_price' | 'free_delivery'
	percentBp?: number | null
	amountMinor?: number | null
	currency?: string | null
	scope: 'order' | 'items' | 'categories'
	itemIds?: readonly string[]
	categoryIds?: readonly string[]
	excludeItemIds?: readonly string[]
	excludeCategoryIds?: readonly string[]
	/** The App's verdict: a plain percent or per-item amount, no condition. */
	itemPrice?: boolean
}

export type MenuSalePrice = {
	/** The regular price, in minor units. */
	originalMinor: number
	/** The price after the one discount, in minor units; below `originalMinor`. */
	saleMinor: number
	/** The discount that sets it. */
	promotionId?: string
}

/**
 * The sale price of an item, or null. `promotions` are the ones already live
 * here and now (location, time, order type). `directCategoryIds` is the item's
 * own category only: the region matches a category offer by it.
 */
export function menuItemSalePrice<T extends MenuPricePromotion>(
	promotions: readonly T[],
	item: {
		id: string
		directCategoryIds: readonly string[]
		priceMinor: number
		currency: string
		/** The item or one of the variants shown is excluded from discounts. */
		excludeFromDiscounts?: boolean
	},
): MenuSalePrice | null {
	if (item.excludeFromDiscounts) return null
	if (!Number.isSafeInteger(item.priceMinor) || item.priceMinor <= 0)
		return null
	const covering = promotions.filter((promotion) => {
		// Free delivery never changes an item's price.
		if (promotion.valueType === 'free_delivery') return false
		if (promotion.excludeItemIds?.includes(item.id)) return false
		if (
			promotion.excludeCategoryIds?.some((id) =>
				item.directCategoryIds.includes(id),
			)
		) {
			return false
		}
		return (
			promotion.scope === 'order' ||
			Boolean(promotion.itemIds?.includes(item.id)) ||
			Boolean(
				promotion.categoryIds?.some((id) =>
					item.directCategoryIds.includes(id),
				),
			)
		)
	})
	// Two offers may stack or compete, and an unconditional one is the only kind
	// whose effect on a lone item is known: anything else keeps the badge.
	if (covering.length !== 1) return null
	const promotion = covering[0]!
	if (promotion.itemPrice !== true) return null
	let off = 0
	if (promotion.valueType === 'percent') {
		const bp = promotion.percentBp ?? 0
		if (!Number.isSafeInteger(bp) || bp < 1 || bp > BASIS_POINTS) return null
		off = mulDiv(item.priceMinor, bp, BASIS_POINTS)
	} else if (promotion.valueType === 'fixed') {
		if (promotion.scope === 'order') return null
		if (
			promotion.currency &&
			promotion.currency.toLowerCase() !== item.currency.toLowerCase()
		) {
			return null
		}
		const amount = promotion.amountMinor ?? 0
		if (!Number.isSafeInteger(amount) || amount < 1) return null
		off = Math.min(amount, item.priceMinor)
	} else {
		return null
	}
	if (off <= 0) return null
	return {
		originalMinor: item.priceMinor,
		saleMinor: item.priceMinor - off,
		...(promotion.id ? { promotionId: promotion.id } : {}),
	}
}
