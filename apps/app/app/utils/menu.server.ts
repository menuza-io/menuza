import { and, asc, eq, inArray } from 'drizzle-orm'
import {
	getTenantDb,
	menuCategories,
	menuItems,
	menuModifierGroups,
	menuModifierOptions,
} from '@repo/tenant-db'
import { z } from 'zod'

import { getDefaultOrganizationLocationId } from '#app/utils/organization/locations.server.ts'

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

export async function resolveMenuLocationId(
	organizationId: string,
	locationId?: string | null,
) {
	if (locationId) return locationId
	const defaultId = await getDefaultOrganizationLocationId(organizationId)
	if (!defaultId) {
		throw new Error('No restaurant location configured')
	}
	return defaultId
}

export async function listMenuCategories(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getTenantDb(organizationId)
	return tenantDb
		.select()
		.from(menuCategories)
		.where(
			and(
				eq(menuCategories.locationId, locationId),
				eq(menuCategories.active, true),
			),
		)
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))
}

export async function listMenuForLocation(
	organizationId: string,
	locationId: string,
) {
	const tenantDb = await getTenantDb(organizationId)
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

export async function createMenuCategory(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuCategorySchema>,
) {
	const parsed = menuCategorySchema.parse(input)
	const tenantDb = await getTenantDb(organizationId)
	const [created] = await tenantDb
		.insert(menuCategories)
		.values({
			locationId,
			...parsed,
		})
		.returning()
	return created
}

export async function createMenuItem(
	organizationId: string,
	locationId: string,
	input: z.infer<typeof menuItemSchema>,
) {
	const parsed = menuItemSchema.parse(input)
	const tenantDb = await getTenantDb(organizationId)
	const [created] = await tenantDb
		.insert(menuItems)
		.values({
			...parsed,
			locationId,
		})
		.returning()
	return created
}
