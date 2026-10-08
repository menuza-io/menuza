import { type OrderingCategory, type OrderingItem } from './types.ts'

export type CatalogIndex = {
	items: Map<string, OrderingItem>
	categories: Map<string, OrderingCategory>
	/** Item id to the ids of every category (and ancestor) it is listed under. */
	itemCategoryIds: Map<string, string[]>
}

export function indexCatalog(categories: OrderingCategory[]): CatalogIndex {
	const index: CatalogIndex = {
		items: new Map(),
		categories: new Map(),
		itemCategoryIds: new Map(),
	}

	const walk = (category: OrderingCategory, ancestors: string[]) => {
		const path = [...ancestors, category.id]
		index.categories.set(category.id, category)
		for (const item of category.items ?? []) {
			if (!index.items.has(item.id)) index.items.set(item.id, item)
			const existing = index.itemCategoryIds.get(item.id) ?? []
			index.itemCategoryIds.set(
				item.id,
				Array.from(new Set([...existing, ...path])),
			)
		}
		for (const sub of category.subcategories ?? []) walk(sub, path)
	}

	for (const category of categories) walk(category, [])
	return index
}

export function isItemSoldOut(item: OrderingItem): boolean {
	if (item.availabilityStatus === 'unavailable') return true
	const variants = item.variations?.variants ?? []
	return (
		variants.length > 0 &&
		variants.every((variant) => variant.availabilityStatus === 'unavailable')
	)
}

export function itemHasChoices(item: OrderingItem): boolean {
	return (
		(item.modifierGroups?.length ?? 0) > 0 ||
		(item.variations?.groups?.length ?? 0) > 0
	)
}

export function lowestAvailablePrice(item: OrderingItem): number {
	const available = (item.variations?.variants ?? []).filter(
		(variant) => variant.availabilityStatus !== 'unavailable',
	)
	if (!available.length) return item.price
	return Math.min(...available.map((variant) => variant.price))
}

export function itemHasPriceRange(item: OrderingItem): boolean {
	const available = (item.variations?.variants ?? []).filter(
		(variant) => variant.availabilityStatus !== 'unavailable',
	)
	if (available.length < 2) return false
	const prices = new Set(available.map((variant) => variant.price))
	return prices.size > 1
}

export function itemPriceLabel(
	item: OrderingItem,
	options: {
		formatMoney: (amount: number) => string
		fromLabel: string
		soldOutLabel: string
	},
): string {
	if (isItemSoldOut(item)) return options.soldOutLabel
	const price = options.formatMoney(lowestAvailablePrice(item))
	return itemHasPriceRange(item) ? `${options.fromLabel} ${price}` : price
}

export function flattenItems(categories: OrderingCategory[]): OrderingItem[] {
	const seen = new Set<string>()
	const out: OrderingItem[] = []
	const walk = (category: OrderingCategory) => {
		for (const item of category.items ?? []) {
			if (seen.has(item.id)) continue
			seen.add(item.id)
			out.push(item)
		}
		for (const sub of category.subcategories ?? []) walk(sub)
	}
	for (const category of categories) walk(category)
	return out
}
