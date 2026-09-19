import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
	getTenantDb,
	menuCategories,
	menuCategoryLinks,
	menuItemModifierSetLinks,
	menuItems,
	menuModifierOptions,
	menuModifierSets,
	menus,
} from '@repo/tenant-db'
import { z } from 'zod'

export const menuCategorySchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional().nullable(),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
	active: z.boolean().optional().default(true),
})

export const menuItemSchema = z.object({
	categoryId: z.string().min(1),
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(1000).optional().nullable(),
	priceCents: z.coerce.number().int().min(0),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
	active: z.boolean().optional().default(true),
})

export const menuSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional().nullable(),
	active: z.boolean().optional().default(true),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
})

export const menuModifierGroupSchema = z.object({
	menuItemId: z.string().min(1).optional(),
	name: z.string().trim().min(1).max(120),
	minSelections: z.coerce.number().int().min(0).optional().default(0),
	maxSelections: z.coerce.number().int().min(1).optional().default(1),
	required: z.boolean().optional().default(false),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
})

export const menuModifierSetSchema = z.object({
	name: z.string().trim().min(1).max(120),
	minSelections: z.coerce.number().int().min(0).optional().default(0),
	maxSelections: z.coerce.number().int().min(1).optional().default(1),
	required: z.boolean().optional().default(false),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
})

export const menuModifierOptionSchema = z.object({
	name: z.string().trim().min(1).max(120),
	priceCents: z.coerce.number().int().min(0).optional().default(0),
	sortOrder: z.coerce.number().int().min(0).optional().default(0),
})

const DEFAULT_MENU_NAME = 'Main menu'

async function tenantDb(organizationId: string) {
	return getTenantDb(organizationId, { createIfMissing: true })
}

function assertLocationRow<T extends { locationId: string }>(
	row: T | undefined,
	locationId: string,
	label: string,
) {
	if (!row || row.locationId !== locationId) {
		throw new Response(`${label} not found`, { status: 404 })
	}
	return row
}

export async function ensureDefaultMenu(
	organizationId: string,
	locationId: string,
) {
	const db = await tenantDb(organizationId)
	const existing = await db
		.select()
		.from(menus)
		.where(eq(menus.locationId, locationId))
		.orderBy(asc(menus.sortOrder))
		.limit(1)

	if (existing.length) return existing[0]

	const [created] = await db
		.insert(menus)
		.values({
			locationId,
			name: DEFAULT_MENU_NAME,
			active: true,
			sortOrder: 0,
		})
		.returning()

	const categories = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.locationId, locationId))
		.orderBy(asc(menuCategories.sortOrder))

	if (categories.length) {
		await db.insert(menuCategoryLinks).values(
			categories.map((category, index) => ({
				menuId: created!.id,
				categoryId: category.id,
				sortOrder: index,
			})),
		)
	}

	return created!
}

export async function listMenusForLocation(
	organizationId: string,
	locationId: string,
) {
	await ensureDefaultMenu(organizationId, locationId)
	const db = await tenantDb(organizationId)
	return db
		.select()
		.from(menus)
		.where(eq(menus.locationId, locationId))
		.orderBy(asc(menus.sortOrder), asc(menus.name))
}

export async function getMenu(
	organizationId: string,
	locationId: string,
	menuId: string,
) {
	const db = await tenantDb(organizationId)
	const [menu] = await db
		.select()
		.from(menus)
		.where(eq(menus.id, menuId))
		.limit(1)
	assertLocationRow(menu, locationId, 'Menu')

	const links = await db
		.select({
			linkId: menuCategoryLinks.id,
			sortOrder: menuCategoryLinks.sortOrder,
			category: menuCategories,
		})
		.from(menuCategoryLinks)
		.innerJoin(
			menuCategories,
			eq(menuCategoryLinks.categoryId, menuCategories.id),
		)
		.where(eq(menuCategoryLinks.menuId, menuId))
		.orderBy(asc(menuCategoryLinks.sortOrder), asc(menuCategories.name))

	return {
		...menu,
		categories: links.map((row) => ({
			...row.category,
			linkSortOrder: row.sortOrder,
			linkId: row.linkId,
		})),
	}
}

export async function createMenu(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuSchema>,
) {
	const parsed = menuSchema.parse(input)
	const db = await tenantDb(organizationId)
	const [created] = await db
		.insert(menus)
		.values({ locationId, ...parsed })
		.returning()
	return created
}

export async function updateMenu(
	organizationId: string,
	locationId: string,
	menuId: string,
	input: z.infer<typeof menuSchema>,
) {
	const parsed = menuSchema.parse(input)
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menus)
		.where(eq(menus.id, menuId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Menu')
	const [updated] = await db
		.update(menus)
		.set({ ...parsed, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menus.id, menuId))
		.returning()
	return updated
}

export async function deleteMenu(
	organizationId: string,
	locationId: string,
	menuId: string,
) {
	const db = await tenantDb(organizationId)
	const allMenus = await listMenusForLocation(organizationId, locationId)
	if (allMenus.length <= 1) {
		throw new Response('Keep at least one menu for this location.', {
			status: 400,
		})
	}
	const [existing] = await db
		.select()
		.from(menus)
		.where(eq(menus.id, menuId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Menu')
	await db.delete(menus).where(eq(menus.id, menuId))
}

export async function setMenuActive(
	organizationId: string,
	locationId: string,
	menuId: string,
	active: boolean,
) {
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menus)
		.where(eq(menus.id, menuId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Menu')
	await db
		.update(menus)
		.set({ active, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menus.id, menuId))
}

export async function linkCategoryToMenu(
	organizationId: string,
	locationId: string,
	menuId: string,
	categoryId: string,
) {
	const db = await tenantDb(organizationId)
	await getMenu(organizationId, locationId, menuId)
	const [category] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	const existing = await db
		.select()
		.from(menuCategoryLinks)
		.where(
			and(
				eq(menuCategoryLinks.menuId, menuId),
				eq(menuCategoryLinks.categoryId, categoryId),
			),
		)
		.limit(1)
	if (existing.length) return existing[0]

	const links = await db
		.select({ sortOrder: menuCategoryLinks.sortOrder })
		.from(menuCategoryLinks)
		.where(eq(menuCategoryLinks.menuId, menuId))
	const nextOrder = links.length
		? Math.max(...links.map((l) => l.sortOrder)) + 1
		: 0

	const [created] = await db
		.insert(menuCategoryLinks)
		.values({ menuId, categoryId, sortOrder: nextOrder })
		.returning()
	return created
}

export async function unlinkCategoryFromMenu(
	organizationId: string,
	locationId: string,
	menuId: string,
	categoryId: string,
) {
	await getMenu(organizationId, locationId, menuId)
	const db = await tenantDb(organizationId)
	await db
		.delete(menuCategoryLinks)
		.where(
			and(
				eq(menuCategoryLinks.menuId, menuId),
				eq(menuCategoryLinks.categoryId, categoryId),
			),
		)
}

export async function reorderMenuCategories(
	organizationId: string,
	locationId: string,
	menuId: string,
	orderedCategoryIds: string[],
) {
	await getMenu(organizationId, locationId, menuId)
	const db = await tenantDb(organizationId)
	for (let index = 0; index < orderedCategoryIds.length; index++) {
		const categoryId = orderedCategoryIds[index]!
		await db
			.update(menuCategoryLinks)
			.set({ sortOrder: index })
			.where(
				and(
					eq(menuCategoryLinks.menuId, menuId),
					eq(menuCategoryLinks.categoryId, categoryId),
				),
			)
	}
}

export async function reorderCategories(
	organizationId: string,
	locationId: string,
	orderedCategoryIds: string[],
) {
	const db = await tenantDb(organizationId)
	for (let index = 0; index < orderedCategoryIds.length; index++) {
		const categoryId = orderedCategoryIds[index]!
		const [row] = await db
			.select()
			.from(menuCategories)
			.where(eq(menuCategories.id, categoryId))
			.limit(1)
		assertLocationRow(row, locationId, 'Category')
		await db
			.update(menuCategories)
			.set({ sortOrder: index, updatedAt: sql`(strftime('%s', 'now'))` })
			.where(eq(menuCategories.id, categoryId))
	}
	const defaultMenu = await ensureDefaultMenu(organizationId, locationId)
	await reorderMenuCategories(
		organizationId,
		locationId,
		defaultMenu!.id,
		orderedCategoryIds,
	)
}

export async function reorderItemsInCategory(
	organizationId: string,
	locationId: string,
	categoryId: string,
	orderedItemIds: string[],
) {
	const db = await tenantDb(organizationId)
	const [category] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	for (let index = 0; index < orderedItemIds.length; index++) {
		const itemId = orderedItemIds[index]!
		await db
			.update(menuItems)
			.set({ sortOrder: index, updatedAt: sql`(strftime('%s', 'now'))` })
			.where(
				and(eq(menuItems.id, itemId), eq(menuItems.categoryId, categoryId)),
			)
	}
}

export async function reorderModifierOptions(
	organizationId: string,
	locationId: string,
	modifierSetId: string,
	orderedOptionIds: string[],
) {
	await getModifierSet(organizationId, locationId, modifierSetId)
	const db = await tenantDb(organizationId)
	for (let index = 0; index < orderedOptionIds.length; index++) {
		const optionId = orderedOptionIds[index]!
		await db
			.update(menuModifierOptions)
			.set({ sortOrder: index })
			.where(
				and(
					eq(menuModifierOptions.id, optionId),
					eq(menuModifierOptions.modifierSetId, modifierSetId),
				),
			)
	}
}

export async function listMenuForLocation(
	organizationId: string,
	locationId: string,
	menuId?: string,
) {
	const resolvedMenuId =
		menuId ?? (await ensureDefaultMenu(organizationId, locationId))!.id
	const menu = await getMenu(organizationId, locationId, resolvedMenuId)

	const categoryIds = menu.categories.map((c) => c.id)
	if (!categoryIds.length) return { menu, categories: [] as const }

	const db = await tenantDb(organizationId)
	const items = await db
		.select()
		.from(menuItems)
		.where(inArray(menuItems.categoryId, categoryIds))
		.orderBy(asc(menuItems.sortOrder), asc(menuItems.name))

	const itemIds = items.map((i) => i.id)
	const setLinks = itemIds.length
		? await db
				.select()
				.from(menuItemModifierSetLinks)
				.where(inArray(menuItemModifierSetLinks.menuItemId, itemIds))
				.orderBy(asc(menuItemModifierSetLinks.sortOrder))
		: []

	const setIds = [...new Set(setLinks.map((l) => l.modifierSetId))]
	const sets = setIds.length
		? await db
				.select()
				.from(menuModifierSets)
				.where(inArray(menuModifierSets.id, setIds))
		: []

	const options = setIds.length
		? await db
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.modifierSetId, setIds))
				.orderBy(asc(menuModifierOptions.sortOrder))
		: []

	const sortIndex = new Map(menu.categories.map((c, i) => [c.id, i]))
	const sortedCategories = [...menu.categories].sort(
		(a, b) => (sortIndex.get(a.id) ?? 0) - (sortIndex.get(b.id) ?? 0),
	)

	return {
		menu,
		categories: sortedCategories.map((category) => ({
			...category,
			items: items
				.filter((item) => item.categoryId === category.id)
				.sort((a, b) => a.sortOrder - b.sortOrder)
				.map((item) => ({
					...item,
					modifierSets: setLinks
						.filter((link) => link.menuItemId === item.id)
						.map((link) => {
							const set = sets.find((s) => s.id === link.modifierSetId)
							if (!set) return null
							return {
								...set,
								options: options.filter((o) => o.modifierSetId === set.id),
							}
						})
						.filter(Boolean),
				})),
		})),
	}
}

export async function listCategoriesForLocation(
	organizationId: string,
	locationId: string,
) {
	const db = await tenantDb(organizationId)
	return db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.locationId, locationId))
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))
}

export async function listItemsForLocation(
	organizationId: string,
	locationId: string,
	categoryId?: string,
) {
	const db = await tenantDb(organizationId)
	const conditions = categoryId
		? and(
				eq(menuItems.locationId, locationId),
				eq(menuItems.categoryId, categoryId),
			)
		: eq(menuItems.locationId, locationId)
	return db
		.select()
		.from(menuItems)
		.where(conditions)
		.orderBy(asc(menuItems.sortOrder), asc(menuItems.name))
}

export async function listModifierSetsForLocation(
	organizationId: string,
	locationId: string,
) {
	const db = await tenantDb(organizationId)
	const sets = await db
		.select()
		.from(menuModifierSets)
		.where(eq(menuModifierSets.locationId, locationId))
		.orderBy(asc(menuModifierSets.sortOrder), asc(menuModifierSets.name))

	const setIds = sets.map((s) => s.id)
	const options = setIds.length
		? await db
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.modifierSetId, setIds))
		: []

	const links = setIds.length
		? await db
				.select()
				.from(menuItemModifierSetLinks)
				.where(inArray(menuItemModifierSetLinks.modifierSetId, setIds))
		: []

	const itemIds = [...new Set(links.map((l) => l.menuItemId))]
	const items = itemIds.length
		? await db
				.select({ id: menuItems.id, name: menuItems.name })
				.from(menuItems)
				.where(inArray(menuItems.id, itemIds))
		: []
	const itemNameById = new Map(items.map((i) => [i.id, i.name]))

	return sets.map((set) => ({
		...set,
		options: options
			.filter((o) => o.modifierSetId === set.id)
			.sort((a, b) => a.sortOrder - b.sortOrder),
		attachedItems: links
			.filter((l) => l.modifierSetId === set.id)
			.map((l) => ({
				id: l.menuItemId,
				name: itemNameById.get(l.menuItemId) ?? '',
			})),
	}))
}

/** @deprecated Use listModifierSetsForLocation */
export const listModifierGroupsForLocation = listModifierSetsForLocation

export async function getMenuItem(
	organizationId: string,
	locationId: string,
	itemId: string,
) {
	const db = await tenantDb(organizationId)
	const [item] = await db
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(item, locationId, 'Item')

	const links = await db
		.select()
		.from(menuItemModifierSetLinks)
		.where(eq(menuItemModifierSetLinks.menuItemId, itemId))
		.orderBy(asc(menuItemModifierSetLinks.sortOrder))

	const setIds = links.map((l) => l.modifierSetId)
	const sets = setIds.length
		? await db
				.select()
				.from(menuModifierSets)
				.where(inArray(menuModifierSets.id, setIds))
		: []

	const options = setIds.length
		? await db
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.modifierSetId, setIds))
				.orderBy(asc(menuModifierOptions.sortOrder))
		: []

	return {
		...item,
		modifierSets: links
			.map((link) => {
				const set = sets.find((s) => s.id === link.modifierSetId)
				if (!set) return null
				return {
					...set,
					options: options.filter((o) => o.modifierSetId === set.id),
				}
			})
			.filter(Boolean),
	}
}

export async function getModifierSet(
	organizationId: string,
	locationId: string,
	modifierSetId: string,
) {
	const db = await tenantDb(organizationId)
	const [set] = await db
		.select()
		.from(menuModifierSets)
		.where(eq(menuModifierSets.id, modifierSetId))
		.limit(1)
	if (!set || set.locationId !== locationId) {
		throw new Response('Modifier group not found', { status: 404 })
	}

	const options = await db
		.select()
		.from(menuModifierOptions)
		.where(eq(menuModifierOptions.modifierSetId, modifierSetId))
		.orderBy(asc(menuModifierOptions.sortOrder))

	const links = await db
		.select()
		.from(menuItemModifierSetLinks)
		.where(eq(menuItemModifierSetLinks.modifierSetId, modifierSetId))

	const itemIds = links.map((l) => l.menuItemId)
	const items = itemIds.length
		? await db.select().from(menuItems).where(inArray(menuItems.id, itemIds))
		: []

	return { ...set, options, attachedItems: items }
}

/** @deprecated */
export const getModifierGroup = getModifierSet

export async function createMenuCategory(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuCategorySchema>,
) {
	const parsed = menuCategorySchema.parse(input)
	const db = await tenantDb(organizationId)
	const [created] = await db
		.insert(menuCategories)
		.values({ locationId, ...parsed })
		.returning()
	const defaultMenu = await ensureDefaultMenu(organizationId, locationId)
	await linkCategoryToMenu(
		organizationId,
		locationId,
		defaultMenu!.id,
		created!.id,
	)
	return created
}

export async function updateMenuCategory(
	organizationId: string,
	locationId: string,
	categoryId: string,
	input: z.infer<typeof menuCategorySchema>,
) {
	const parsed = menuCategorySchema.parse(input)
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')

	const [updated] = await db
		.update(menuCategories)
		.set({ ...parsed, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menuCategories.id, categoryId))
		.returning()
	return updated
}

export async function deleteMenuCategory(
	organizationId: string,
	locationId: string,
	categoryId: string,
) {
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')
	await db.delete(menuCategories).where(eq(menuCategories.id, categoryId))
}

export async function setMenuCategoryActive(
	organizationId: string,
	locationId: string,
	categoryId: string,
	active: boolean,
) {
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')
	await db
		.update(menuCategories)
		.set({ active, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menuCategories.id, categoryId))
}

export async function createMenuItem(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuItemSchema>,
) {
	const parsed = menuItemSchema.parse(input)
	const db = await tenantDb(organizationId)
	const [category] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, parsed.categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	const siblings = await db
		.select({ sortOrder: menuItems.sortOrder })
		.from(menuItems)
		.where(eq(menuItems.categoryId, parsed.categoryId))
	const nextOrder =
		parsed.sortOrder ??
		(siblings.length ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0)

	const [created] = await db
		.insert(menuItems)
		.values({ ...parsed, locationId, sortOrder: nextOrder })
		.returning()
	return created
}

export async function updateMenuItem(
	organizationId: string,
	locationId: string,
	itemId: string,
	input: z.infer<typeof menuItemSchema>,
) {
	const parsed = menuItemSchema.parse(input)
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')

	const [category] = await db
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, parsed.categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	const [updated] = await db
		.update(menuItems)
		.set({ ...parsed, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menuItems.id, itemId))
		.returning()
	return updated
}

export async function deleteMenuItem(
	organizationId: string,
	locationId: string,
	itemId: string,
) {
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')
	await db.delete(menuItems).where(eq(menuItems.id, itemId))
}

export async function setMenuItemActive(
	organizationId: string,
	locationId: string,
	itemId: string,
	active: boolean,
) {
	const db = await tenantDb(organizationId)
	const [existing] = await db
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')
	await db
		.update(menuItems)
		.set({ active, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menuItems.id, itemId))
}

export async function createModifierSet(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuModifierSetSchema>,
) {
	const parsed = menuModifierSetSchema.parse(input)
	const db = await tenantDb(organizationId)
	const [created] = await db
		.insert(menuModifierSets)
		.values({ locationId, ...parsed })
		.returning()
	return created
}

export async function updateModifierSet(
	organizationId: string,
	locationId: string,
	modifierSetId: string,
	input: z.infer<typeof menuModifierSetSchema>,
) {
	const parsed = menuModifierSetSchema.parse(input)
	const db = await tenantDb(organizationId)
	await getModifierSet(organizationId, locationId, modifierSetId)
	const [updated] = await db
		.update(menuModifierSets)
		.set(parsed)
		.where(eq(menuModifierSets.id, modifierSetId))
		.returning()
	return updated
}

/** @deprecated */
export const updateModifierGroup = updateModifierSet
/** @deprecated */
export const deleteModifierGroup = deleteModifierSet

export async function deleteModifierSet(
	organizationId: string,
	locationId: string,
	modifierSetId: string,
) {
	await getModifierSet(organizationId, locationId, modifierSetId)
	const db = await tenantDb(organizationId)
	await db
		.delete(menuModifierSets)
		.where(eq(menuModifierSets.id, modifierSetId))
}

export async function attachModifierSetToItem(
	organizationId: string,
	locationId: string,
	itemId: string,
	modifierSetId: string,
) {
	const db = await tenantDb(organizationId)
	const [item] = await db
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(item, locationId, 'Item')
	await getModifierSet(organizationId, locationId, modifierSetId)

	const existing = await db
		.select()
		.from(menuItemModifierSetLinks)
		.where(
			and(
				eq(menuItemModifierSetLinks.menuItemId, itemId),
				eq(menuItemModifierSetLinks.modifierSetId, modifierSetId),
			),
		)
		.limit(1)
	if (existing.length) return

	const links = await db
		.select({ sortOrder: menuItemModifierSetLinks.sortOrder })
		.from(menuItemModifierSetLinks)
		.where(eq(menuItemModifierSetLinks.menuItemId, itemId))
	const nextOrder = links.length
		? Math.max(...links.map((l) => l.sortOrder)) + 1
		: 0

	await db.insert(menuItemModifierSetLinks).values({
		menuItemId: itemId,
		modifierSetId,
		sortOrder: nextOrder,
	})
}

export async function detachModifierSetFromItem(
	organizationId: string,
	locationId: string,
	itemId: string,
	modifierSetId: string,
) {
	await getMenuItem(organizationId, locationId, itemId)
	const db = await tenantDb(organizationId)
	await db
		.delete(menuItemModifierSetLinks)
		.where(
			and(
				eq(menuItemModifierSetLinks.menuItemId, itemId),
				eq(menuItemModifierSetLinks.modifierSetId, modifierSetId),
			),
		)
}

/** @deprecated */
export async function createModifierGroup(
	organizationId: string,
	locationId: string,
	input: { menuItemId: string; name: string },
) {
	const set = await createModifierSet(
		organizationId,
		locationId,
		menuModifierSetSchema.parse({ name: input.name }),
	)
	await attachModifierSetToItem(
		organizationId,
		locationId,
		input.menuItemId,
		set!.id,
	)
	return set
}

export async function createModifierOption(
	organizationId: string,
	locationId: string,
	modifierSetId: string,
	input: z.infer<typeof menuModifierOptionSchema>,
) {
	const parsed = menuModifierOptionSchema.parse(input)
	await getModifierSet(organizationId, locationId, modifierSetId)
	const db = await tenantDb(organizationId)
	const [created] = await db
		.insert(menuModifierOptions)
		.values({ ...parsed, modifierSetId })
		.returning()
	return created
}

export async function deleteModifierOption(
	organizationId: string,
	locationId: string,
	optionId: string,
) {
	const db = await tenantDb(organizationId)
	const [option] = await db
		.select()
		.from(menuModifierOptions)
		.where(eq(menuModifierOptions.id, optionId))
		.limit(1)
	if (!option) throw new Response('Option not found', { status: 404 })
	await getModifierSet(organizationId, locationId, option.modifierSetId)
	await db
		.delete(menuModifierOptions)
		.where(eq(menuModifierOptions.id, optionId))
}

export async function getMenuOverviewStats(
	organizationId: string,
	locationId: string,
) {
	await ensureDefaultMenu(organizationId, locationId)
	const [menuList, categories, items, sets] = await Promise.all([
		listMenusForLocation(organizationId, locationId),
		listCategoriesForLocation(organizationId, locationId),
		listItemsForLocation(organizationId, locationId),
		listModifierSetsForLocation(organizationId, locationId),
	])
	return {
		menuCount: menuList.length,
		categoryCount: categories.length,
		itemCount: items.length,
		modifierSetCount: sets.length,
		activeMenuName:
			menuList.find((m) => m.active)?.name ?? menuList[0]?.name ?? '',
	}
}
