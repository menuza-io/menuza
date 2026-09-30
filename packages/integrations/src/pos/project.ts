/**
 * Projects a menuza menu into the canonical provider shapes (`RemoteItem[]`,
 * `RemoteMenu[]`). This is the bridge between the app's menu tables and the
 * wire codecs.
 */

import {
	isUnavailableUntilExpired,
	parseMenuVariations,
	type MenuVariations,
} from '@repo/common/menu-types'
import {
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroupOptionAssignment,
	and,
	asc,
	db,
	eq,
	inArray,
} from '@repo/database'
import { PosError } from './errors.ts'
import { type RemoteItem, type RemoteMenu } from './types.ts'

export type SyncableMenu = {
	menu: { id: string; name: string }
	items: RemoteItem[]
	menus: RemoteMenu[]
}

/** Resolves a localized menu column (`{"en":"…"}`) to a plain string. */
export function localizedText(
	value: string | null | undefined,
	fallback = '',
): string {
	if (!value) return fallback
	if (value.startsWith('{')) {
		try {
			const parsed = JSON.parse(value) as Record<string, string>
			return parsed.en || Object.values(parsed).find(Boolean) || fallback
		} catch {
			return value
		}
	}
	return value
}

function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return []
	try {
		const parsed = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

/**
 * Loads a single menu (categories → items → modifier groups → options) as the
 * canonical items a provider would receive.
 */
export async function loadMenuForSync(
	organizationId: string,
	menuId: string,
): Promise<SyncableMenu> {
	const menu = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, menuId),
				eq(OrganizationMenu.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0])

	if (!menu) throw new PosError('Menu not found.', 404)
	const menuName = localizedText(menu.displayName, 'Menu')

	const categoryAssignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))
	const categoryIds = categoryAssignments.map((row) => row.categoryId)

	const itemRows = categoryIds.length
		? await db.query.OrganizationMenuItemCategoryAssignment.findMany({
				where: inArray(
					OrganizationMenuItemCategoryAssignment.categoryId,
					categoryIds,
				),
				orderBy: asc(OrganizationMenuItemCategoryAssignment.position),
				with: { category: true, item: true },
			})
		: []
	const itemIds = itemRows.map((row) => row.itemId)

	const groupRows = itemIds.length
		? await db.query.OrganizationMenuItemModifierGroupAssignment.findMany({
				where: inArray(
					OrganizationMenuItemModifierGroupAssignment.itemId,
					itemIds,
				),
				orderBy: asc(OrganizationMenuItemModifierGroupAssignment.position),
				with: { modifierGroup: true },
			})
		: []
	const groupIds = [...new Set(groupRows.map((row) => row.modifierGroupId))]

	const optionRows = groupIds.length
		? await db.query.OrganizationMenuModifierGroupOptionAssignment.findMany({
				where: inArray(
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
					groupIds,
				),
				orderBy: asc(OrganizationMenuModifierGroupOptionAssignment.position),
				with: { option: true },
			})
		: []

	const groupsByItem = new Map<string, typeof groupRows>()
	for (const row of groupRows) {
		const list = groupsByItem.get(row.itemId) ?? []
		list.push(row)
		groupsByItem.set(row.itemId, list)
	}
	const optionsByGroup = new Map<string, typeof optionRows>()
	for (const row of optionRows) {
		const list = optionsByGroup.get(row.modifierGroupId) ?? []
		list.push(row)
		optionsByGroup.set(row.modifierGroupId, list)
	}

	const items: RemoteItem[] = itemRows.map(({ item, category }) => {
		const groups = (groupsByItem.get(item.id) ?? []).flatMap((assignment) => {
			const group = assignment.modifierGroup
			if (!group) return []
			const options = (optionsByGroup.get(group.id) ?? []).map((optionRow) => ({
				name: localizedText(optionRow.option?.displayName, 'Option'),
				price: Math.round(
					(optionRow.priceOverride ?? optionRow.option?.price ?? 0) * 100,
				),
				available: optionRow.option?.availabilityStatus !== 'unavailable',
			}))
			const max = group.maxSelections ?? Math.max(options.length, 1)
			return [
				{
					name: localizedText(group.name, 'Options'),
					min: group.minSelections ?? 0,
					max,
					options,
				},
			]
		})

		const allergens = [
			...parseStringArray(item.allergens),
			...(item.isVegetarian ? ['vegetarian'] : []),
			...(item.isGlutenFree ? ['gluten-free'] : []),
		]

		const menuVariations = parseMenuVariations(item.variations)
		const remoteVariations = projectMenuVariations(menuVariations)
		const availableVariants = menuVariations.variants.filter((variant) =>
			isUnavailableUntilExpired(
				variant.availabilityStatus,
				variant.unavailableUntil,
			),
		)
		const priceCents = availableVariants.length
			? Math.round(
					Math.min(...availableVariants.map((variant) => variant.price)) * 100,
				)
			: Math.round(item.price * 100)

		return {
			id: item.id,
			name: localizedText(item.displayName, 'Item'),
			description: localizedText(item.description),
			category: localizedText(category?.displayName, 'Uncategorized'),
			price: priceCents,
			imageUrl: item.imageUrl ?? null,
			available:
				isUnavailableUntilExpired(
					item.availabilityStatus,
					item.unavailableUntil,
				) &&
				(!menuVariations.variants.length || availableVariants.length > 0),
			modifierGroups: groups,
			variations: remoteVariations,
			menus: [],
			allergens: [...new Set(allergens)].sort(),
			alcohol: item.isAlcohol,
			taxRate: null,
			version: 1,
		}
	})

	return { menu: { id: menu.id, name: menuName }, items, menus: [] }
}

/** Preserve complete sellable combinations and their prices in the POS catalog. */
export function projectMenuVariations(
	variations: MenuVariations,
	now = new Date(),
): RemoteItem['variations'] {
	return variations.variants
		.filter((variant) =>
			isUnavailableUntilExpired(
				variant.availabilityStatus,
				variant.unavailableUntil,
				now,
			),
		)
		.map((variant) => ({
			name: variant.valueIds
				.map(
					(id, index) =>
						variations.groups[index]?.values.find((value) => value.id === id)
							?.name ?? '',
				)
				.join(' / '),
			price: Math.round(variant.price * 100),
		}))
}
