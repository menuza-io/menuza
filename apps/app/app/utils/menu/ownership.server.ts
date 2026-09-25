import { isValidParentCategory } from '@repo/common/menu-types'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from '@repo/database'

async function orgOwnedIds(
	rows: { id: string }[],
	submittedIds: string[],
	label: string,
) {
	const owned = new Set(rows.map((row) => row.id))
	const foreign = submittedIds.filter((id) => !owned.has(id))
	if (foreign.length > 0) {
		throw new Response(`${label} not found`, { status: 404 })
	}
	return submittedIds
}

export async function assertMenuInOrganization(
	organizationId: string,
	menuId: string,
) {
	const rows = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, menuId),
				eq(OrganizationMenu.organizationId, organizationId),
			),
		)
		.limit(1)

	if (rows.length === 0) {
		throw new Response('Menu not found', { status: 404 })
	}
}

export async function assertCategoryInOrganization(
	organizationId: string,
	categoryId: string,
) {
	const rows = await db
		.select({ id: OrganizationMenuCategory.id })
		.from(OrganizationMenuCategory)
		.where(
			and(
				eq(OrganizationMenuCategory.id, categoryId),
				eq(OrganizationMenuCategory.organizationId, organizationId),
			),
		)
		.limit(1)

	if (rows.length === 0) {
		throw new Response('Category not found', { status: 404 })
	}
}

export async function assertItemInOrganization(
	organizationId: string,
	itemId: string,
) {
	const rows = await db
		.select({ id: OrganizationMenuItem.id })
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, itemId),
				eq(OrganizationMenuItem.organizationId, organizationId),
			),
		)
		.limit(1)

	if (rows.length === 0) {
		throw new Response('Item not found', { status: 404 })
	}
}

export async function assertModifierGroupInOrganization(
	organizationId: string,
	modifierGroupId: string,
) {
	const rows = await db
		.select({ id: OrganizationMenuModifierGroup.id })
		.from(OrganizationMenuModifierGroup)
		.where(
			and(
				eq(OrganizationMenuModifierGroup.id, modifierGroupId),
				eq(OrganizationMenuModifierGroup.organizationId, organizationId),
			),
		)
		.limit(1)

	if (rows.length === 0) {
		throw new Response('Modifier group not found', { status: 404 })
	}
}

export async function assertCategoryIdsInOrganization(
	organizationId: string,
	categoryIds: string[],
) {
	if (categoryIds.length === 0) return []
	const rows = await db
		.select({ id: OrganizationMenuCategory.id })
		.from(OrganizationMenuCategory)
		.where(
			and(
				eq(OrganizationMenuCategory.organizationId, organizationId),
				inArray(OrganizationMenuCategory.id, categoryIds),
			),
		)
	return orgOwnedIds(rows, categoryIds, 'Category')
}

export async function assertItemIdsInOrganization(
	organizationId: string,
	itemIds: string[],
) {
	if (itemIds.length === 0) return []
	const rows = await db
		.select({ id: OrganizationMenuItem.id })
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, organizationId),
				inArray(OrganizationMenuItem.id, itemIds),
			),
		)
	return orgOwnedIds(rows, itemIds, 'Item')
}

export async function assertModifierGroupIdsInOrganization(
	organizationId: string,
	modifierGroupIds: string[],
) {
	if (modifierGroupIds.length === 0) return []
	const rows = await db
		.select({ id: OrganizationMenuModifierGroup.id })
		.from(OrganizationMenuModifierGroup)
		.where(
			and(
				eq(OrganizationMenuModifierGroup.organizationId, organizationId),
				inArray(OrganizationMenuModifierGroup.id, modifierGroupIds),
			),
		)
	return orgOwnedIds(rows, modifierGroupIds, 'Modifier group')
}

export async function assertOptionIdsInOrganization(
	organizationId: string,
	optionIds: string[],
) {
	if (optionIds.length === 0) return []
	const rows = await db
		.select({ id: OrganizationMenuOption.id })
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.organizationId, organizationId),
				inArray(OrganizationMenuOption.id, optionIds),
			),
		)
	return orgOwnedIds(rows, optionIds, 'Option')
}

export async function assertLocationIdsInOrganization(
	organizationId: string,
	locationIds: string[],
) {
	if (locationIds.length === 0) return []
	const rows = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				inArray(OrganizationLocation.id, locationIds),
			),
		)
	return orgOwnedIds(rows, locationIds, 'Location')
}

export async function assertValidParentCategoryInOrganization(
	organizationId: string,
	categoryId: string | null | undefined,
	parentId: string | null | undefined,
) {
	if (!parentId) return null
	const allCategories = await db
		.select({
			id: OrganizationMenuCategory.id,
			parentId: OrganizationMenuCategory.parentId,
		})
		.from(OrganizationMenuCategory)
		.where(eq(OrganizationMenuCategory.organizationId, organizationId))

	const check = isValidParentCategory(categoryId, parentId, allCategories, 3)
	if (!check.valid) {
		throw new Response(check.reason || 'Invalid parent category', {
			status: 400,
		})
	}
	return parentId
}
