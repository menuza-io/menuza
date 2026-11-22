import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	asc,
	db,
	eq,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'
import { orgSiteLocales } from '#app/utils/location-name.server.ts'

/** Most menu entries sent to the browser for joining names onto region ids. */
const MENU_NAMES_CAP = 500

export type MenuNames = {
	dishes: { id: string; name: string }[]
	options: { id: string; name: string }[]
}

/**
 * The region knows dishes and options by id only; the App joins their names
 * from the menu it owns. Used where a screen lists recipes (where an item is
 * used, setup checks).
 */
export async function loadMenuNames(organizationId: string): Promise<MenuNames> {
	const [{ defaultLocale }, items, options] = await Promise.all([
		orgSiteLocales(organizationId),
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				internalName: OrganizationMenuItem.internalName,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuItem.position))
			.limit(MENU_NAMES_CAP),
		db
			.select({
				id: OrganizationMenuOption.id,
				displayName: OrganizationMenuOption.displayName,
				internalName: OrganizationMenuOption.internalName,
			})
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
			.limit(MENU_NAMES_CAP),
	])
	const name = (row: {
		displayName: Parameters<typeof getLocalizedMenuValue>[0]
		internalName: string | null
	}) =>
		getLocalizedMenuValue(row.displayName, defaultLocale, defaultLocale) ||
		row.internalName ||
		''
	return {
		dishes: items.map((row) => ({ id: row.id, name: name(row) })),
		options: options.map((row) => ({ id: row.id, name: name(row) })),
	}
}
