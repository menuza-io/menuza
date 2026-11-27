import { createId } from '@paralleldrive/cuid2'
import { dietaryColumns } from '@repo/common/menu-types'
import {
	db,
	eq,
	inArray,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import {
	type MenuFile,
	type MenuFileRecord,
	serializeMenuFile,
} from './menu-file.ts'
import { createMenuSnapshot } from './snapshot.server.ts'

const CHANNELS = '["web","qr","pos","app"]'

export async function loadMenuFile(
	organizationId: string,
	exportedAt = new Date().toISOString(),
): Promise<MenuFile> {
	const [menus, categories, items, groups, options] = await Promise.all([
		db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.organizationId, organizationId)),
		db
			.select()
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
	])
	const menuIds = menus.map((row) => row.id)
	const categoryIds = categories.map((row) => row.id)
	const itemIds = items.map((row) => row.id)
	const groupIds = groups.map((row) => row.id)
	const [menuCategories, categoryItems, itemGroups, groupOptions] =
		await Promise.all([
			menuIds.length
				? db
						.select()
						.from(OrganizationMenuCategoryAssignment)
						.where(inArray(OrganizationMenuCategoryAssignment.menuId, menuIds))
				: [],
			categoryIds.length
				? db
						.select()
						.from(OrganizationMenuItemCategoryAssignment)
						.where(
							inArray(
								OrganizationMenuItemCategoryAssignment.categoryId,
								categoryIds,
							),
						)
				: [],
			itemIds.length
				? db
						.select()
						.from(OrganizationMenuItemModifierGroupAssignment)
						.where(
							inArray(
								OrganizationMenuItemModifierGroupAssignment.itemId,
								itemIds,
							),
						)
				: [],
			groupIds.length
				? db
						.select()
						.from(OrganizationMenuModifierGroupOptionAssignment)
						.where(
							inArray(
								OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
								groupIds,
							),
						)
				: [],
		])
	const records: MenuFileRecord = {
		menus: menus.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			internalName: row.internalName,
			menuType: row.menuType,
			nutritionalInfo: row.nutritionalInfo,
			calorieDisplay: row.calorieDisplay,
			specialInstructions: row.specialInstructions,
			availabilityStatus: row.availabilityStatus,
			channels: row.channels,
			position: row.position,
		})),
		categories: categories.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			internalName: row.internalName,
			description: row.description,
			parentId: row.parentId,
			availabilityStatus: row.availabilityStatus,
			channels: row.channels,
			position: row.position,
		})),
		items: items.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			internalName: row.internalName,
			description: row.description,
			price: row.price,
			imageUrl: row.imageUrl,
			variations: row.variations,
			dietaryTags: row.dietaryTags,
			allergens: row.allergens,
			calorieMin: row.calorieMin,
			calorieMax: row.calorieMax,
			barcode: row.barcode,
			availabilityStatus: row.availabilityStatus,
			channels: row.channels,
			position: row.position,
			isAlcohol: row.isAlcohol,
			isPopular: row.isPopular,
			isUpsell: row.isUpsell,
		})),
		modifierGroups: groups.map((row) => ({
			id: row.id,
			name: row.name,
			internalName: row.internalName,
			selectionType: row.selectionType,
			minSelections: row.minSelections,
			maxSelections: row.maxSelections,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
		})),
		options: options.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			internalName: row.internalName,
			description: row.description,
			price: row.price,
			calories: row.calories,
			imageUrl: null,
			dietaryTags: row.dietaryTags,
			allergens: row.allergens,
			barcode: row.barcode,
			availabilityStatus: row.availabilityStatus,
			position: row.position,
		})),
		menuCategories: menuCategories.map((row) => ({
			menuId: row.menuId,
			categoryId: row.categoryId,
			position: row.position,
		})),
		categoryItems: categoryItems.map((row) => ({
			categoryId: row.categoryId,
			itemId: row.itemId,
			position: row.position,
		})),
		itemGroups: itemGroups.map((row) => ({
			itemId: row.itemId,
			modifierGroupId: row.modifierGroupId,
			position: row.position,
		})),
		groupOptions: groupOptions.map((row) => ({
			modifierGroupId: row.modifierGroupId,
			optionId: row.optionId,
			position: row.position,
		})),
	}
	return serializeMenuFile(records, exportedAt)
}

export type ApplyMenuFileResult = {
	snapshotId: string
	created: number
	updated: number
}

/**
 * Writes a validated file. Source ids that already belong to this
 * organization are updated; every other id is created new. A snapshot is
 * taken first so the import can be restored from menu history.
 */
export async function applyMenuFile(input: {
	organizationId: string
	userId: string
	file: MenuFile
}): Promise<ApplyMenuFileResult> {
	const snapshotId = await createMenuSnapshot({
		organizationId: input.organizationId,
		reason: 'before_import',
		userId: input.userId,
		label: 'Before menu file import',
	})
	const existing = await loadIdSets(input.organizationId)
	const map = new Map<string, string>()
	let created = 0
	let updated = 0
	const take = (sourceId: string, have: Set<string>) => {
		if (have.has(sourceId)) {
			map.set(sourceId, sourceId)
			updated += 1
			return sourceId
		}
		const next = createId()
		map.set(sourceId, next)
		created += 1
		return next
	}

	await db.transaction(async (tx) => {
		for (const menu of input.file.menus) {
			const id = take(menu.id, existing.menus)
			const values = {
				displayName: menu.displayName,
				internalName: menu.internalName ?? null,
				menuType: menu.menuType,
				nutritionalInfo: menu.nutritionalInfo,
				calorieDisplay: menu.calorieDisplay ?? null,
				specialInstructions: menu.specialInstructions,
				availabilityStatus: menu.availabilityStatus,
				channels: menu.channels || CHANNELS,
				position: menu.position,
			}
			if (existing.menus.has(menu.id)) {
				await tx
					.update(OrganizationMenu)
					.set(values)
					.where(eq(OrganizationMenu.id, id))
			} else {
				await tx.insert(OrganizationMenu).values({
					id,
					organizationId: input.organizationId,
					...values,
				})
			}
		}
		for (const category of input.file.categories) {
			const id = take(category.id, existing.categories)
			const values = {
				displayName: category.displayName,
				internalName: category.internalName ?? null,
				description: category.description ?? null,
				availabilityStatus: category.availabilityStatus,
				channels: category.channels || CHANNELS,
				position: category.position,
			}
			if (existing.categories.has(category.id)) {
				await tx
					.update(OrganizationMenuCategory)
					.set(values)
					.where(eq(OrganizationMenuCategory.id, id))
			} else {
				await tx.insert(OrganizationMenuCategory).values({
					id,
					organizationId: input.organizationId,
					...values,
				})
			}
		}
		for (const category of input.file.categories) {
			const parent = category.parentId ? map.get(category.parentId) : null
			if (!parent) continue
			await tx
				.update(OrganizationMenuCategory)
				.set({ parentId: parent })
				.where(eq(OrganizationMenuCategory.id, map.get(category.id)!))
		}
		for (const item of input.file.items) {
			const id = take(item.id, existing.items)
			const tags = dietaryColumns(item.dietaryTags)
			const values = {
				displayName: item.displayName,
				internalName: item.internalName ?? null,
				description: item.description ?? null,
				price: item.price,
				imageUrl: item.imageUrl ?? null,
				variations: item.variations,
				...tags,
				allergens: JSON.stringify(item.allergens),
				calorieMin: item.calorieMin,
				calorieMax: item.calorieMax,
				barcode: item.barcode ?? null,
				availabilityStatus: item.availabilityStatus,
				channels: item.channels || CHANNELS,
				position: item.position,
				isAlcohol: item.isAlcohol,
				isPopular: item.isPopular,
				isUpsell: item.isUpsell,
			}
			if (existing.items.has(item.id)) {
				await tx
					.update(OrganizationMenuItem)
					.set(values)
					.where(eq(OrganizationMenuItem.id, id))
			} else {
				await tx.insert(OrganizationMenuItem).values({
					id,
					organizationId: input.organizationId,
					...values,
				})
			}
		}
		for (const group of input.file.modifierGroups) {
			const id = take(group.id, existing.groups)
			const values = {
				name: group.name,
				internalName: group.internalName ?? null,
				selectionType: group.selectionType,
				minSelections: group.minSelections,
				maxSelections: group.maxSelections,
				availabilityStatus: group.availabilityStatus,
				position: group.position,
			}
			if (existing.groups.has(group.id)) {
				await tx
					.update(OrganizationMenuModifierGroup)
					.set(values)
					.where(eq(OrganizationMenuModifierGroup.id, id))
			} else {
				await tx.insert(OrganizationMenuModifierGroup).values({
					id,
					organizationId: input.organizationId,
					...values,
				})
			}
		}
		for (const option of input.file.options) {
			const id = take(option.id, existing.options)
			const tags = dietaryColumns(option.dietaryTags)
			const values = {
				displayName: option.displayName,
				internalName: option.internalName ?? null,
				description: option.description ?? null,
				price: option.price,
				calories: option.calories,
				...tags,
				allergens: JSON.stringify(option.allergens),
				barcode: option.barcode ?? null,
				availabilityStatus: option.availabilityStatus,
				position: option.position,
			}
			if (existing.options.has(option.id)) {
				await tx
					.update(OrganizationMenuOption)
					.set(values)
					.where(eq(OrganizationMenuOption.id, id))
			} else {
				await tx.insert(OrganizationMenuOption).values({
					id,
					organizationId: input.organizationId,
					...values,
				})
			}
		}

		const menuIds = [...map.values()]
		if (menuIds.length) {
			await tx.delete(OrganizationMenuCategoryAssignment).where(
				inArray(
					OrganizationMenuCategoryAssignment.menuId,
					input.file.menus.map((row) => map.get(row.id)!),
				),
			)
		}
		for (const link of input.file.menuCategories) {
			const menuId = map.get(link.parentId)
			const categoryId = map.get(link.childId)
			if (!menuId || !categoryId) continue
			await tx.insert(OrganizationMenuCategoryAssignment).values({
				menuId,
				categoryId,
				position: link.position,
			})
		}
		const categoryIds = input.file.categories.map((row) => map.get(row.id)!)
		if (categoryIds.length) {
			await tx
				.delete(OrganizationMenuItemCategoryAssignment)
				.where(
					inArray(
						OrganizationMenuItemCategoryAssignment.categoryId,
						categoryIds,
					),
				)
		}
		for (const link of input.file.categoryItems) {
			const categoryId = map.get(link.parentId)
			const itemId = map.get(link.childId)
			if (!categoryId || !itemId) continue
			await tx.insert(OrganizationMenuItemCategoryAssignment).values({
				categoryId,
				itemId,
				position: link.position,
			})
		}
		const itemIds = input.file.items.map((row) => map.get(row.id)!)
		if (itemIds.length) {
			await tx
				.delete(OrganizationMenuItemModifierGroupAssignment)
				.where(
					inArray(OrganizationMenuItemModifierGroupAssignment.itemId, itemIds),
				)
		}
		for (const link of input.file.itemGroups) {
			const itemId = map.get(link.parentId)
			const modifierGroupId = map.get(link.childId)
			if (!itemId || !modifierGroupId) continue
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values({
				itemId,
				modifierGroupId,
				position: link.position,
			})
		}
		const groupIds = input.file.modifierGroups.map((row) => map.get(row.id)!)
		if (groupIds.length) {
			await tx
				.delete(OrganizationMenuModifierGroupOptionAssignment)
				.where(
					inArray(
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
						groupIds,
					),
				)
		}
		for (const link of input.file.groupOptions) {
			const modifierGroupId = map.get(link.parentId)
			const optionId = map.get(link.childId)
			if (!modifierGroupId || !optionId) continue
			await tx.insert(OrganizationMenuModifierGroupOptionAssignment).values({
				modifierGroupId,
				optionId,
				position: link.position,
			})
		}
	})

	return { snapshotId, created, updated }
}

async function loadIdSets(organizationId: string) {
	const [menus, categories, items, groups, options] = await Promise.all([
		db
			.select({ id: OrganizationMenu.id })
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuCategory.id })
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuModifierGroup.id })
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
	])
	return {
		menus: new Set(menus.map((row) => row.id)),
		categories: new Set(categories.map((row) => row.id)),
		items: new Set(items.map((row) => row.id)),
		groups: new Set(groups.map((row) => row.id)),
		options: new Set(options.map((row) => row.id)),
	}
}
