import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	asc,
	db,
	eq,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'

export type ProfitabilityDish = {
	id: string
	name: string
	/** Menu price in major units. */
	price: number
	/** The category the dish is compared within: its first one. */
	categoryKey: string
	categoryName: string
}

/** Most dishes the page asks the region about (it answers up to 1,000 at once). */
const MAX_DISHES = 1_000

/**
 * The menu's dishes for the profitability report (#519): the region knows
 * dishes by id and numbers only, so the App joins their names, prices and the
 * category each dish is compared within (its first category, in menu order).
 * Loaded by organization and joined in memory (D1 allows 100 bound parameters).
 */
export async function loadProfitabilityDishes(
	organizationId: string,
	defaultLocale: string,
): Promise<ProfitabilityDish[]> {
	const [items, links, categories] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				price: OrganizationMenuItem.price,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuItem.position), asc(OrganizationMenuItem.id))
			.limit(MAX_DISHES),
		db
			.select({
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
				categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
				position: OrganizationMenuItemCategoryAssignment.position,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuItem,
				eq(
					OrganizationMenuItem.id,
					OrganizationMenuItemCategoryAssignment.itemId,
				),
			)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				displayName: OrganizationMenuCategory.displayName,
				position: OrganizationMenuCategory.position,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
	])
	const categoryById = new Map(categories.map((row) => [row.id, row]))
	const firstByItem = new Map<string, { categoryId: string; order: number }>()
	for (const link of links) {
		const category = categoryById.get(link.categoryId)
		if (!category) continue
		const order = category.position * 10_000 + link.position
		const existing = firstByItem.get(link.itemId)
		if (!existing || order < existing.order) {
			firstByItem.set(link.itemId, { categoryId: link.categoryId, order })
		}
	}
	return items.map((item) => {
		const first = firstByItem.get(item.id)
		const category = first ? categoryById.get(first.categoryId) : undefined
		return {
			id: item.id,
			name:
				getLocalizedMenuValue(item.displayName, defaultLocale, defaultLocale) ||
				item.displayName,
			price: item.price,
			categoryKey: category?.id ?? '',
			categoryName: category
				? getLocalizedMenuValue(
						category.displayName,
						defaultLocale,
						defaultLocale,
					)
				: '',
		}
	})
}
