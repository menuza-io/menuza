import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import {
	computeMenuHealth,
	type MenuHealth,
	type MenuHealthCategory,
	type MenuHealthItem,
} from './menu-health.ts'

export const MENU_HEALTH_ITEM_COLUMNS = {
	id: OrganizationMenuItem.id,
	displayName: OrganizationMenuItem.displayName,
	description: OrganizationMenuItem.description,
	price: OrganizationMenuItem.price,
	imageKey: OrganizationMenuItem.imageKey,
	imageUrl: OrganizationMenuItem.imageUrl,
	imageKeys: OrganizationMenuItem.imageKeys,
	variations: OrganizationMenuItem.variations,
	allergens: OrganizationMenuItem.allergens,
	calorieMin: OrganizationMenuItem.calorieMin,
	calorieMax: OrganizationMenuItem.calorieMax,
	availabilityStatus: OrganizationMenuItem.availabilityStatus,
	unavailableUntil: OrganizationMenuItem.unavailableUntil,
	updatedAt: OrganizationMenuItem.updatedAt,
}

/**
 * Score the whole organization's menu (every item and category, not only the
 * menu tab on screen). Callers must have checked menu read access first.
 */
export async function loadMenuHealth(organization: {
	id: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}): Promise<MenuHealth> {
	const [items, categories, filledCategories] = await Promise.all([
		db
			.select(MENU_HEALTH_ITEM_COLUMNS)
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organization.id)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				parentId: OrganizationMenuCategory.parentId,
				availabilityStatus: OrganizationMenuCategory.availabilityStatus,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organization.id)),
		db
			.selectDistinct({
				categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(eq(OrganizationMenuCategory.organizationId, organization.id)),
	])

	return computeMenuHealthFor(organization, {
		items,
		categories,
		categoryIdsWithItems: filledCategories.map((row) => row.categoryId),
	})
}

export function computeMenuHealthFor(
	organization: {
		siteLocales: string | null
		siteDefaultLocale: string | null
	},
	data: {
		items: MenuHealthItem[]
		categories: MenuHealthCategory[]
		categoryIdsWithItems: Iterable<string>
	},
): MenuHealth {
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	return computeMenuHealth({ ...data, locales, defaultLocale })
}
