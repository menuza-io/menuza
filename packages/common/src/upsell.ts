/**
 * Which dishes to suggest next to a cart (#114), from the published menu's
 * own upsell settings. One rule for every guest surface and the phone agent,
 * so there is no second ranking:
 *
 * 1. dishes in the upsell categories of the categories already in the cart,
 * 2. then dishes the restaurant flagged as upsells,
 * each group in menu order (menu, then category, then dish position).
 *
 * Never a dish that is already in the cart, sold out or unavailable, or that
 * the caller vetoes (not offered for the order type, over a per-order limit).
 * Hidden menus and categories are skipped. With an empty cart only the flagged
 * dishes remain; a screen that shows nothing for an empty cart (the guest cart)
 * decides that itself. Pure: no I/O, no UI strings.
 */

/** The fields of a dish the rule reads; callers pass richer objects. */
export type UpsellItem = {
	id: string
	isUpsell?: boolean | null
	availabilityStatus?: string | null
	variations?: {
		variants?: ReadonlyArray<{ availabilityStatus?: string | null }>
	} | null
}

export type UpsellCategory<I extends UpsellItem = UpsellItem> = {
	id: string
	availabilityStatus?: string | null
	/** Categories whose dishes go well with this one. */
	upsellCategoryIds?: readonly string[] | null
	items: readonly I[]
	subcategories?: ReadonlyArray<UpsellCategory<I>> | null
}

export type UpsellMenu<I extends UpsellItem = UpsellItem> = {
	availabilityStatus?: string | null
	categories: ReadonlyArray<UpsellCategory<I>>
}

export type UpsellPick<I extends UpsellItem> = { item: I; categoryId: string }

/** Most dishes the cart row shows. */
export const UPSELL_MAX_SUGGESTIONS = 6

const isOffered = (status: string | null | undefined) =>
	!status || status === 'available'

/** Sold out: not available, or every variant is. */
export function upsellItemSoldOut(item: UpsellItem): boolean {
	if (!isOffered(item.availabilityStatus)) return true
	const variants = item.variations?.variants ?? []
	return (
		variants.length > 0 &&
		variants.every((variant) => variant.availabilityStatus === 'unavailable')
	)
}

export function pickUpsells<I extends UpsellItem>(input: {
	menus: ReadonlyArray<UpsellMenu<I>>
	/** The dishes in the cart (one id per dish, repeats are fine). */
	cartItemIds: readonly string[]
	limit?: number
	/**
	 * A veto on top of the built-in rules: false drops the dish (not offered for
	 * the chosen order type, over a per-order limit).
	 */
	allow?: (item: I) => boolean
}): Array<UpsellPick<I>> {
	const limit = input.limit ?? UPSELL_MAX_SUGGESTIONS
	if (limit <= 0) return []
	const inCart = new Set(input.cartItemIds)

	// Menu order, each dish once (a dish listed twice keeps its first place).
	// A dish belongs to its category and to every ancestor of it, like the
	// guest menu's own category index.
	type Entry = UpsellPick<I> & { path: readonly string[] }
	const ordered: Entry[] = []
	const categoryById = new Map<string, UpsellCategory<I>>()
	const seen = new Set<string>()
	const visit = (category: UpsellCategory<I>, ancestors: readonly string[]) => {
		if (!isOffered(category.availabilityStatus)) return
		const path = [...ancestors, category.id]
		categoryById.set(category.id, category)
		for (const item of category.items) {
			if (seen.has(item.id)) continue
			seen.add(item.id)
			ordered.push({ item, categoryId: category.id, path })
		}
		for (const sub of category.subcategories ?? []) visit(sub, path)
	}
	for (const menu of input.menus) {
		if (!isOffered(menu.availabilityStatus)) continue
		for (const category of menu.categories) visit(category, [])
	}

	// The categories of what is in the cart, and the categories those point to.
	const cartCategoryIds = new Set<string>()
	for (const entry of ordered) {
		if (inCart.has(entry.item.id)) {
			for (const id of entry.path) cartCategoryIds.add(id)
		}
	}
	const targetCategoryIds = new Set<string>()
	for (const categoryId of cartCategoryIds) {
		for (const target of categoryById.get(categoryId)?.upsellCategoryIds ?? []) {
			targetCategoryIds.add(target)
		}
	}

	const eligible = (entry: Entry) =>
		!inCart.has(entry.item.id) &&
		!upsellItemSoldOut(entry.item) &&
		(input.allow ? input.allow(entry.item) : true)
	const fromCategories = ordered.filter(
		(entry) =>
			entry.path.some((id) => targetCategoryIds.has(id)) && eligible(entry),
	)
	const chosen = new Set(fromCategories.map((entry) => entry.item.id))
	const flagged = ordered.filter(
		(entry) =>
			entry.item.isUpsell === true && !chosen.has(entry.item.id) && eligible(entry),
	)
	return [...fromCategories, ...flagged]
		.slice(0, limit)
		.map(({ item, categoryId }) => ({ item, categoryId }))
}
