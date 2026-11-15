import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { type MenuGraph } from './menu-graph.ts'
import { type MenuSnapshotContent } from './snapshot-types.ts'
import { captureMenuSnapshotContent } from './snapshot.server.ts'

const iso = (value: Date | string) =>
	value instanceof Date ? value.toISOString() : new Date(value).toISOString()

/** The graph view of full menu rows (as a snapshot captures them). */
export function menuGraphFromContent(
	content: MenuSnapshotContent,
	organization: { siteLocales: string | null; siteDefaultLocale: string | null },
): MenuGraph {
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	return {
		defaultLocale,
		locales,
		menus: content.menus.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			updatedAt: iso(row.updatedAt),
		})),
		categories: content.categories.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			parentId: row.parentId,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
			updatedAt: iso(row.updatedAt),
		})),
		items: content.items.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			description: row.description,
			price: row.price,
			variations: row.variations,
			imageUrl: row.imageUrl,
			imageKey: row.imageKey,
			imageKeys: row.imageKeys,
			allergens: row.allergens,
			isAlcohol: row.isAlcohol,
			isGlutenFree: row.isGlutenFree,
			isVegetarian: row.isVegetarian,
			calorieMin: row.calorieMin,
			calorieMax: row.calorieMax,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
			updatedAt: iso(row.updatedAt),
		})),
		groups: content.modifierGroups.map((row) => ({
			id: row.id,
			name: row.name,
			selectionType: row.selectionType,
			minSelections: row.minSelections,
			maxSelections: row.maxSelections,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
			updatedAt: iso(row.updatedAt),
		})),
		options: content.options.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			price: row.price,
			priceWhole: row.priceWhole,
			priceLeft: row.priceLeft,
			priceRight: row.priceRight,
			isTopping: row.isTopping,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
			updatedAt: iso(row.updatedAt),
		})),
		menuCategories: content.menuCategoryAssignments.map((row) => ({
			menuId: row.menuId,
			categoryId: row.categoryId,
			position: row.position,
		})),
		itemCategories: content.itemCategoryAssignments.map((row) => ({
			categoryId: row.categoryId,
			itemId: row.itemId,
			position: row.position,
		})),
		itemGroups: content.itemModifierGroupAssignments.map((row) => ({
			itemId: row.itemId,
			modifierGroupId: row.modifierGroupId,
			position: row.position,
		})),
		groupOptions: content.modifierGroupOptionAssignments.map((row) => ({
			modifierGroupId: row.modifierGroupId,
			optionId: row.optionId,
			position: row.position,
			priceOverride: row.priceOverride,
			priceWholeOverride: row.priceWholeOverride,
			priceLeftOverride: row.priceLeftOverride,
			priceRightOverride: row.priceRightOverride,
			isDefault: row.isDefault,
		})),
		optionGroups: content.optionNestedModifierGroupAssignments.map((row) => ({
			optionId: row.optionId,
			modifierGroupId: row.modifierGroupId,
		})),
		posLinks: content.posLinks.map((row) => ({
			entityType: row.entityType,
			localId: row.localId,
		})),
	}
}

/**
 * The organization's whole menu, read with the same organization-scoped
 * queries a menu snapshot uses (no list sized by the menu is bound). The
 * full rows come back too: Accept copies dishes from them.
 */
export async function loadMenuGraph(organization: {
	id: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}): Promise<{ graph: MenuGraph; content: MenuSnapshotContent }> {
	const content = await captureMenuSnapshotContent(organization.id)
	return { graph: menuGraphFromContent(content, organization), content }
}
