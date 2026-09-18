import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
	getTenantDb,
	menuCategories,
	menuItems,
	menuModifierGroups,
	menuModifierOptions,
} from '@repo/tenant-db'
import { resolvePublishedOrganization } from '../lib/origin.ts'

export const menuRoutes = new Hono()

const publicMenuQuerySchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
	locationId: z.string().min(1),
})

menuRoutes.get('/', async (c) => {
	const parsed = publicMenuQuerySchema.safeParse({
		slug: c.req.query('slug'),
		host: c.req.query('host'),
		locationId: c.req.query('locationId'),
	})

	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.errors[0]?.message || 'Invalid query' },
			400,
		)
	}

	const { slug, host, locationId } = parsed.data
	if (!slug && !host) {
		return c.json({ error: 'slug or host is required' }, 400)
	}

	const organization = await resolvePublishedOrganization({ slug, host })
	if (!organization) {
		return c.json({ error: 'Not found' }, 404)
	}

	const db = await getTenantDb(organization.id)
	const categories = await db
		.select()
		.from(menuCategories)
		.where(
			and(
				eq(menuCategories.locationId, locationId),
				eq(menuCategories.active, true),
			),
		)
		.orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name))

	const categoryIds = categories.map((row) => row.id)
	const items = categoryIds.length
		? await db
				.select()
				.from(menuItems)
				.where(
					and(
						inArray(menuItems.categoryId, categoryIds),
						eq(menuItems.active, true),
					),
				)
				.orderBy(asc(menuItems.sortOrder), asc(menuItems.name))
		: []

	const itemIds = items.map((row) => row.id)
	const groups = itemIds.length
		? await db
				.select()
				.from(menuModifierGroups)
				.where(inArray(menuModifierGroups.menuItemId, itemIds))
				.orderBy(asc(menuModifierGroups.sortOrder))
		: []

	const groupIds = groups.map((row) => row.id)
	const options = groupIds.length
		? await db
				.select()
				.from(menuModifierOptions)
				.where(inArray(menuModifierOptions.groupId, groupIds))
				.orderBy(asc(menuModifierOptions.sortOrder))
		: []

	return c.json({
		locationId,
		categories: categories.map((category) => ({
			id: category.id,
			name: category.name,
			description: category.description,
			items: items
				.filter((item) => item.categoryId === category.id)
				.map((item) => ({
					id: item.id,
					name: item.name,
					description: item.description,
					priceCents: item.priceCents,
					modifierGroups: groups
						.filter((group) => group.menuItemId === item.id)
						.map((group) => ({
							id: group.id,
							name: group.name,
							minSelections: group.minSelections,
							maxSelections: group.maxSelections,
							required: group.required,
							options: options
								.filter((opt) => opt.groupId === group.id)
								.map((opt) => ({
									id: opt.id,
									name: opt.name,
									priceCents: opt.priceCents,
								})),
						})),
				})),
		})),
	})
})
