import { type MenuPricingRule } from '@repo/common/menu-pricing'
import {
	and,
	asc,
	db,
	eq,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuPricingRule,
} from '@repo/database'
import {
	publishPricingRules,
	type MenuStructure,
	type PricingRuleRow,
} from './pricing-rules.ts'

export async function loadPricingRuleRows(
	organizationId: string,
): Promise<PricingRuleRow[]> {
	return db
		.select({
			id: OrganizationMenuPricingRule.id,
			name: OrganizationMenuPricingRule.name,
			percentBp: OrganizationMenuPricingRule.percentBp,
			menuIds: OrganizationMenuPricingRule.menuIds,
			categoryIds: OrganizationMenuPricingRule.categoryIds,
			locationIds: OrganizationMenuPricingRule.locationIds,
			roundingMode: OrganizationMenuPricingRule.roundingMode,
			roundingValue: OrganizationMenuPricingRule.roundingValue,
			excludeMinPrice: OrganizationMenuPricingRule.excludeMinPrice,
			excludeMaxPrice: OrganizationMenuPricingRule.excludeMaxPrice,
			startsAt: OrganizationMenuPricingRule.startsAt,
			endedAt: OrganizationMenuPricingRule.endedAt,
			createdAt: OrganizationMenuPricingRule.createdAt,
		})
		.from(OrganizationMenuPricingRule)
		.where(eq(OrganizationMenuPricingRule.organizationId, organizationId))
		.orderBy(asc(OrganizationMenuPricingRule.createdAt))
}

/** Menu-to-category and category-to-subcategory links of an organization. */
export async function loadMenuStructure(
	organizationId: string,
): Promise<MenuStructure> {
	const [assignments, categories] = await Promise.all([
		db
			.select({
				menuId: OrganizationMenuCategoryAssignment.menuId,
				categoryId: OrganizationMenuCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenu,
				eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
			)
			.where(eq(OrganizationMenu.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				parentId: OrganizationMenuCategory.parentId,
			})
			.from(OrganizationMenuCategory)
			.where(and(eq(OrganizationMenuCategory.organizationId, organizationId))),
	])
	const menuCategoryIds = new Map<string, string[]>()
	for (const row of assignments) {
		const list = menuCategoryIds.get(row.menuId) ?? []
		list.push(row.categoryId)
		menuCategoryIds.set(row.menuId, list)
	}
	const childCategoryIds = new Map<string, string[]>()
	for (const row of categories) {
		if (!row.parentId) continue
		const list = childCategoryIds.get(row.parentId) ?? []
		list.push(row.id)
		childCategoryIds.set(row.parentId, list)
	}
	return { menuCategoryIds, childCategoryIds }
}

/** The organization's live rules as the menu payload publishes them. */
export async function loadPublishedPricingRules(
	organizationId: string,
	now: Date = new Date(),
): Promise<MenuPricingRule[]> {
	const rows = await loadPricingRuleRows(organizationId)
	if (rows.length === 0) return []
	return publishPricingRules(rows, await loadMenuStructure(organizationId), now)
}
