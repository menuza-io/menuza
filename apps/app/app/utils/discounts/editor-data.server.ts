import { getLocationCurrency } from '@repo/common/location-currency'
import {
	parseSiteLocalesConfig,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	asc,
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import { loadLoyaltyCatalog } from '#app/utils/loyalty/catalog.server.ts'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { buildDiscountChoices } from './editor-choices.ts'
import {
	type DiscountChoiceCatalog,
	type DiscountLocationChoice,
} from './editor-model.ts'
import { type OrganizationDiscountIds } from './editor-state-schema.ts'

export type DiscountEditorData = {
	catalog: LoyaltyCatalog
	choices: DiscountChoiceCatalog
	locations: DiscountLocationChoice[]
	/** The website's languages, for the guest-facing name and description. */
	siteLocales: SiteLocalesConfig
}

/**
 * The organization's locations with the currency each one's orders use. This
 * is how the menu context decides it (`public-menu-context.server.ts`): a
 * KSA-region organization is in riyals everywhere, otherwise the address
 * decides.
 */
export async function loadDiscountLocations(
	organizationId: string,
): Promise<DiscountLocationChoice[]> {
	const [rows, [organization]] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				address: OrganizationLocation.address,
				isActive: OrganizationLocation.isActive,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId))
			.orderBy(asc(OrganizationLocation.name)),
		db
			.select({ dataRegion: Organization.dataRegion })
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1),
	])
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		currency:
			organization?.dataRegion === 'ksa'
				? 'SAR'
				: getLocationCurrency(row.address),
		active: row.isActive,
	}))
}

/**
 * Every id a discount of this organization may name: its locations, menu
 * items, categories, modifier groups and options, archived ones included (a
 * discount may still name an item that is hidden today). The save keeps only
 * these (`keepOrganizationIds`).
 */
export async function loadOrganizationDiscountIds(
	organizationId: string,
): Promise<OrganizationDiscountIds> {
	const [locations, items, categories, groups, options] = await Promise.all([
		db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuCategory.id })
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuModifierGroup.id })
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
	])
	const ids = (rows: ReadonlyArray<{ id: string }>) =>
		new Set(rows.map((row) => row.id))
	return {
		locationIds: ids(locations),
		itemIds: ids(items),
		categoryIds: ids(categories),
		modifierGroupIds: ids(groups),
		modifierOptionIds: ids(options),
	}
}

/**
 * Menu and location choices for the editor. Control plane data only: ids and
 * names, never customers.
 */
export async function loadDiscountEditorData(
	organizationId: string,
): Promise<DiscountEditorData> {
	const [
		catalog,
		locations,
		groups,
		options,
		assignments,
		itemVariations,
		siteLocales,
	] = await Promise.all([
		loadLoyaltyCatalog(organizationId),
		loadDiscountLocations(organizationId),
		db
			.select({
				id: OrganizationMenuModifierGroup.id,
				name: OrganizationMenuModifierGroup.name,
				internalName: OrganizationMenuModifierGroup.internalName,
			})
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
			.orderBy(
				asc(OrganizationMenuModifierGroup.position),
				asc(OrganizationMenuModifierGroup.createdAt),
			),
		db
			.select({
				id: OrganizationMenuOption.id,
				displayName: OrganizationMenuOption.displayName,
				internalName: OrganizationMenuOption.internalName,
			})
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
			.orderBy(
				asc(OrganizationMenuOption.position),
				asc(OrganizationMenuOption.createdAt),
			),
		db
			.select({
				groupId: OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				optionId: OrganizationMenuModifierGroupOptionAssignment.optionId,
			})
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(
				OrganizationMenuModifierGroup,
				eq(
					OrganizationMenuModifierGroup.id,
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				),
			)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({ variations: OrganizationMenuItem.variations })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		loadDiscountSiteLocales(organizationId),
	])
	return {
		catalog,
		locations,
		siteLocales,
		choices: buildDiscountChoices({
			groups,
			options,
			assignments,
			itemVariations,
			defaultLocale: siteLocales.defaultLocale,
		}),
	}
}

/**
 * The organization's website languages (Website settings): the discount's
 * guest-facing name and description are written in these.
 */
export async function loadDiscountSiteLocales(
	organizationId: string,
): Promise<SiteLocalesConfig> {
	const [organization] = await db
		.select({
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return parseSiteLocalesConfig(
		organization?.siteLocales,
		organization?.siteDefaultLocale,
	)
}
