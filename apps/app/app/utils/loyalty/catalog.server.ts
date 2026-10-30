import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	asc,
	db,
	eq,
	Organization,
	OrganizationMenuCategory,
	OrganizationMenuItem,
} from '@repo/database'
import { buildLoyaltyCatalog, type LoyaltyCatalog } from './catalog.ts'

/**
 * The organization's menu items and categories for the loyalty pickers: ids
 * and names from the control-plane menu, named in the website's default
 * language. Never member data.
 */
export async function loadLoyaltyCatalog(
	organizationId: string,
): Promise<LoyaltyCatalog> {
	const [[organization], items, categories] = await Promise.all([
		db
			.select({
				siteLocales: Organization.siteLocales,
				siteDefaultLocale: Organization.siteDefaultLocale,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1),
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				internalName: OrganizationMenuItem.internalName,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(
				asc(OrganizationMenuItem.position),
				asc(OrganizationMenuItem.createdAt),
			),
		db
			.select({
				id: OrganizationMenuCategory.id,
				displayName: OrganizationMenuCategory.displayName,
				internalName: OrganizationMenuCategory.internalName,
				parentId: OrganizationMenuCategory.parentId,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId))
			.orderBy(
				asc(OrganizationMenuCategory.position),
				asc(OrganizationMenuCategory.createdAt),
			),
	])
	const { defaultLocale } = parseSiteLocalesConfig(
		organization?.siteLocales,
		organization?.siteDefaultLocale,
	)
	return buildLoyaltyCatalog({ items, categories, locale: defaultLocale })
}
