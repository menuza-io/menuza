import {
	and,
	asc,
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import {
	MENU_ROSTER_MAX_DISHES,
	menuRosterSchema,
	type MenuRoster,
} from '@repo/common/slow-sellers'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine menu roster endpoint:
 * `GET /resources/report/menu-roster?orgId=<id>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`. Lists the
 * organization's dishes by id with name, when each was added, whether it is
 * available, the menu and category it first sits under and where it is hidden
 * (#261). The regional tenant-api joins it with sales so a dish that sold
 * nothing still appears in the Slow sellers report. Menu data only (the same a
 * public menu shows): no guest data.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const { orgId } = parsed.data
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)
	if (!organization) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	// Loaded by organization and joined in memory: D1 allows 100 bound
	// parameters per statement, so a menu of any size never rides an IN list.
	const [items, menus, menuCategories, categories, itemCategories, overrides, locations] =
		await Promise.all([
			db
				.select({
					id: OrganizationMenuItem.id,
					displayName: OrganizationMenuItem.displayName,
					price: OrganizationMenuItem.price,
					createdAt: OrganizationMenuItem.createdAt,
					availabilityStatus: OrganizationMenuItem.availabilityStatus,
					unavailableUntil: OrganizationMenuItem.unavailableUntil,
				})
				.from(OrganizationMenuItem)
				.where(eq(OrganizationMenuItem.organizationId, orgId))
				.orderBy(asc(OrganizationMenuItem.position), asc(OrganizationMenuItem.id))
				.limit(MENU_ROSTER_MAX_DISHES),
			db
				.select({
					id: OrganizationMenu.id,
					displayName: OrganizationMenu.displayName,
					menuType: OrganizationMenu.menuType,
					position: OrganizationMenu.position,
				})
				.from(OrganizationMenu)
				.where(eq(OrganizationMenu.organizationId, orgId))
				.orderBy(asc(OrganizationMenu.position), asc(OrganizationMenu.id)),
			db
				.select({
					menuId: OrganizationMenuCategoryAssignment.menuId,
					categoryId: OrganizationMenuCategoryAssignment.categoryId,
					position: OrganizationMenuCategoryAssignment.position,
				})
				.from(OrganizationMenuCategoryAssignment)
				.innerJoin(
					OrganizationMenu,
					eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
				)
				.where(eq(OrganizationMenu.organizationId, orgId)),
			db
				.select({
					id: OrganizationMenuCategory.id,
					displayName: OrganizationMenuCategory.displayName,
					parentId: OrganizationMenuCategory.parentId,
					position: OrganizationMenuCategory.position,
				})
				.from(OrganizationMenuCategory)
				.where(eq(OrganizationMenuCategory.organizationId, orgId)),
			db
				.select({
					itemId: OrganizationMenuItemCategoryAssignment.itemId,
					categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
					position: OrganizationMenuItemCategoryAssignment.position,
				})
				.from(OrganizationMenuItemCategoryAssignment)
				.innerJoin(
					OrganizationMenuItem,
					eq(
						OrganizationMenuItem.id,
						OrganizationMenuItemCategoryAssignment.itemId,
					),
				)
				.where(eq(OrganizationMenuItem.organizationId, orgId)),
			db
				.select({
					locationId: OrganizationMenuLocationOverride.locationId,
					entityId: OrganizationMenuLocationOverride.entityId,
					isEnabled: OrganizationMenuLocationOverride.isEnabled,
					availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
					unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
				})
				.from(OrganizationMenuLocationOverride)
				.where(
					and(
						eq(OrganizationMenuLocationOverride.organizationId, orgId),
						eq(OrganizationMenuLocationOverride.entityType, 'item'),
					),
				),
			db
				.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, orgId))
				.limit(500),
		])

	const menuById = new Map(menus.map((menu) => [menu.id, menu]))
	const categoryById = new Map(categories.map((category) => [category.id, category]))
	// A category's menu and its place in it: the top category's assignment.
	const rootOf = (categoryId: string): string => {
		let current = categoryById.get(categoryId)
		let guard = 0
		while (current?.parentId && guard++ < 10) {
			current = categoryById.get(current.parentId)
		}
		return current?.id ?? categoryId
	}
	type Placement = {
		menuId: string
		menuOrder: number
		categoryPosition: number
		depth: number
	}
	const placementOfCategory = new Map<string, Placement>()
	for (const assignment of menuCategories) {
		const menu = menuById.get(assignment.menuId)
		if (!menu || menu.menuType === 'drop') continue
		for (const category of categories) {
			if (rootOf(category.id) !== assignment.categoryId) continue
			const depth = category.id === assignment.categoryId ? 0 : 1
			const candidate: Placement = {
				menuId: menu.id,
				menuOrder: menus.indexOf(menu),
				categoryPosition: assignment.position,
				depth,
			}
			const existing = placementOfCategory.get(category.id)
			if (
				!existing ||
				candidate.menuOrder < existing.menuOrder ||
				(candidate.menuOrder === existing.menuOrder &&
					candidate.categoryPosition < existing.categoryPosition)
			) {
				placementOfCategory.set(category.id, candidate)
			}
		}
	}
	const firstPlacement = new Map<
		string,
		{ categoryId: string; placement: Placement; position: number }
	>()
	for (const link of itemCategories) {
		const placement = placementOfCategory.get(link.categoryId)
		if (!placement) continue
		const existing = firstPlacement.get(link.itemId)
		const better =
			!existing ||
			placement.menuOrder < existing.placement.menuOrder ||
			(placement.menuOrder === existing.placement.menuOrder &&
				(placement.categoryPosition < existing.placement.categoryPosition ||
					(placement.categoryPosition === existing.placement.categoryPosition &&
						(placement.depth < existing.placement.depth ||
							(placement.depth === existing.placement.depth &&
								link.position < existing.position)))))
		if (better) {
			firstPlacement.set(link.itemId, {
				categoryId: link.categoryId,
				placement,
				position: link.position,
			})
		}
	}
	const hiddenByItem = new Map<string, string[]>()
	const now = Date.now()
	for (const override of overrides) {
		const off =
			override.isEnabled === false ||
			(override.availabilityStatus !== null &&
				override.availabilityStatus !== 'available' &&
				!(override.unavailableUntil && override.unavailableUntil.getTime() <= now))
		if (!off) continue
		const list = hiddenByItem.get(override.entityId) ?? []
		list.push(override.locationId)
		hiddenByItem.set(override.entityId, list)
	}

	const roster: MenuRoster = menuRosterSchema.parse({
		orgId,
		dishes: items.map((item) => {
			const place = firstPlacement.get(item.id)
			const category = place ? categoryById.get(place.categoryId) : undefined
			const menu = place ? menuById.get(place.placement.menuId) : undefined
			return {
				id: item.id,
				name: item.displayName,
				createdAt: item.createdAt.getTime(),
				availabilityStatus: item.availabilityStatus,
				unavailableUntil: item.unavailableUntil?.getTime() ?? null,
				categoryId: category?.id ?? '',
				categoryName: category?.displayName ?? '',
				menuId: menu?.id ?? '',
				menuName: menu?.displayName ?? '',
				price: item.price,
				hiddenLocationIds: hiddenByItem.get(item.id) ?? [],
			}
		}),
		locations,
	})
	return Response.json(roster, { headers: { 'Cache-Control': 'no-store' } })
}
