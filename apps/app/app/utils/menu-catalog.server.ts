import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
	getTenantDb,
	menuCategories,
	menuItems,
	menuModifierGroups,
	menuModifierOptions,
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

export const menuModifierGroupSchema = z.object({
	menuItemId: z.string().min(1),
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

/** Menu runs in the App against regional SQLite; repair missing files after publish. */
async function getMenuTenantDb(organizationId: string) {
	return getTenantDb(organizationId, { createIfMissing: true })
}

export async function listMenuForLocation(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const categories = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.locationId, locationId))
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))

	if (!categories.length) {
		return { categories: [] as const }
	}

	const categoryIds = categories.map((c) => c.id)
	const items = await tenantDb
		.select()
		.from(menuItems)
		.where(inArray(menuItems.categoryId, categoryIds))
		.orderBy(asc(menuItems.sortOrder), asc(menuItems.name))

	const itemIds = items.map((i) => i.id)
	const groups = itemIds.length
		? await tenantDb
				.select()
				.from(menuModifierGroups)
				.where(inArray(menuModifierGroups.menuItemId, itemIds))
				.orderBy(asc(menuModifierGroups.sortOrder))
		: []

	const groupIds = groups.map((g) => g.id)
	const options = groupIds.length
		? await tenantDb
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.groupId, groupIds))
				.orderBy(asc(menuModifierOptions.sortOrder))
		: []

	return {
		categories: categories.map((category) => ({
			...category,
			items: items
				.filter((item) => item.categoryId === category.id)
				.map((item) => ({
					...item,
					modifierGroups: groups
						.filter((group) => group.menuItemId === item.id)
						.map((group) => ({
							...group,
							options: options.filter((opt) => opt.groupId === group.id),
						})),
				})),
		})),
	}
}

export async function listCategoriesForLocation(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	return tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.locationId, locationId))
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))
}

export async function listItemsForLocation(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	return tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.locationId, locationId))
		.orderBy(asc(menuItems.sortOrder), asc(menuItems.name))
}

export async function listModifierGroupsForLocation(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const items = await tenantDb
		.select({ id: menuItems.id, name: menuItems.name })
		.from(menuItems)
		.where(eq(menuItems.locationId, locationId))

	const itemIds = items.map((i) => i.id)
	if (!itemIds.length) return []

	const groups = await tenantDb
		.select()
		.from(menuModifierGroups)
		.where(inArray(menuModifierGroups.menuItemId, itemIds))
		.orderBy(asc(menuModifierGroups.sortOrder), asc(menuModifierGroups.name))

	const groupIds = groups.map((g) => g.id)
	const options = groupIds.length
		? await tenantDb
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.groupId, groupIds))
		: []

	const itemNameById = new Map(items.map((i) => [i.id, i.name]))

	return groups.map((group) => ({
		...group,
		itemName: itemNameById.get(group.menuItemId) ?? '',
		options: options.filter((o) => o.groupId === group.id),
	}))
}

export async function getMenuItem(
	organizationId: string,
	locationId: string,
	itemId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const [item] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(item, locationId, 'Item')

	const groups = await tenantDb
		.select()
		.from(menuModifierGroups)
		.where(eq(menuModifierGroups.menuItemId, itemId))
		.orderBy(asc(menuModifierGroups.sortOrder))

	const groupIds = groups.map((g) => g.id)
	const options = groupIds.length
		? await tenantDb
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.groupId, groupIds))
				.orderBy(asc(menuModifierOptions.sortOrder))
		: []

	return {
		...item,
		modifierGroups: groups.map((group) => ({
			...group,
			options: options.filter((o) => o.groupId === group.id),
		})),
	}
}

export async function getModifierGroup(
	organizationId: string,
	locationId: string,
	groupId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const [group] = await tenantDb
		.select()
		.from(menuModifierGroups)
		.where(eq(menuModifierGroups.id, groupId))
		.limit(1)
	if (!group) throw new Response('Modifier group not found', { status: 404 })

	const [item] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, group.menuItemId))
		.limit(1)
	assertLocationRow(item, locationId, 'Modifier group')

	const options = await tenantDb
		.select()
		.from(menuModifierOptions)
		.where(eq(menuModifierOptions.groupId, groupId))
		.orderBy(asc(menuModifierOptions.sortOrder))

	return { ...group, item, options }
}

export async function createMenuCategory(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuCategorySchema>,
) {
	const parsed = menuCategorySchema.parse(input)
	const tenantDb = await getMenuTenantDb(organizationId)
	const [created] = await tenantDb
		.insert(menuCategories)
		.values({ locationId, ...parsed })
		.returning()
	return created
}

export async function updateMenuCategory(
	organizationId: string,
	locationId: string,
	categoryId: string,
	input: z.infer<typeof menuCategorySchema>,
) {
	const parsed = menuCategorySchema.parse(input)
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')

	const [updated] = await tenantDb
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
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')
	await tenantDb.delete(menuCategories).where(eq(menuCategories.id, categoryId))
}

export async function setMenuCategoryActive(
	organizationId: string,
	locationId: string,
	categoryId: string,
	active: boolean,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, categoryId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Category')
	await tenantDb
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
	const tenantDb = await getMenuTenantDb(organizationId)
	const [category] = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, parsed.categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	const [created] = await tenantDb
		.insert(menuItems)
		.values({ ...parsed, locationId })
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
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')

	const [category] = await tenantDb
		.select()
		.from(menuCategories)
		.where(eq(menuCategories.id, parsed.categoryId))
		.limit(1)
	assertLocationRow(category, locationId, 'Category')

	const [updated] = await tenantDb
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
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')
	await tenantDb.delete(menuItems).where(eq(menuItems.id, itemId))
}

export async function setMenuItemActive(
	organizationId: string,
	locationId: string,
	itemId: string,
	active: boolean,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const [existing] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, itemId))
		.limit(1)
	assertLocationRow(existing, locationId, 'Item')
	await tenantDb
		.update(menuItems)
		.set({ active, updatedAt: sql`(strftime('%s', 'now'))` })
		.where(eq(menuItems.id, itemId))
}

export async function createModifierGroup(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuModifierGroupSchema>,
) {
	const parsed = menuModifierGroupSchema.parse(input)
	const tenantDb = await getMenuTenantDb(organizationId)
	const [item] = await tenantDb
		.select()
		.from(menuItems)
		.where(eq(menuItems.id, parsed.menuItemId))
		.limit(1)
	assertLocationRow(item, locationId, 'Item')

	const [created] = await tenantDb
		.insert(menuModifierGroups)
		.values(parsed)
		.returning()
	return created
}

export async function updateModifierGroup(
	organizationId: string,
	locationId: string,
	groupId: string,
	input: Omit<z.infer<typeof menuModifierGroupSchema>, 'menuItemId'>,
) {
	const parsed = menuModifierGroupSchema.omit({ menuItemId: true }).parse(input)
	const tenantDb = await getMenuTenantDb(organizationId)
	await getModifierGroup(organizationId, locationId, groupId)
	const [updated] = await tenantDb
		.update(menuModifierGroups)
		.set(parsed)
		.where(eq(menuModifierGroups.id, groupId))
		.returning()
	return updated
}

export async function deleteModifierGroup(
	organizationId: string,
	locationId: string,
	groupId: string,
) {
	await getModifierGroup(organizationId, locationId, groupId)
	const tenantDb = await getMenuTenantDb(organizationId)
	await tenantDb
		.delete(menuModifierGroups)
		.where(eq(menuModifierGroups.id, groupId))
}

export async function createModifierOption(
	organizationId: string,
	locationId: string,
	groupId: string,
	input: z.infer<typeof menuModifierOptionSchema>,
) {
	const parsed = menuModifierOptionSchema.parse(input)
	await getModifierGroup(organizationId, locationId, groupId)
	const tenantDb = await getMenuTenantDb(organizationId)
	const [created] = await tenantDb
		.insert(menuModifierOptions)
		.values({ ...parsed, groupId })
		.returning()
	return created
}

export async function deleteModifierOption(
	organizationId: string,
	locationId: string,
	optionId: string,
) {
	const tenantDb = await getMenuTenantDb(organizationId)
	const [option] = await tenantDb
		.select()
		.from(menuModifierOptions)
		.where(eq(menuModifierOptions.id, optionId))
		.limit(1)
	if (!option) throw new Response('Option not found', { status: 404 })
	await getModifierGroup(organizationId, locationId, option.groupId)
	await tenantDb
		.delete(menuModifierOptions)
		.where(eq(menuModifierOptions.id, optionId))
}
