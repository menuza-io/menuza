import { getLocationCurrency } from '@repo/common/location-currency'
import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
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
import {
	type DiscountChoiceCatalog,
	type DiscountLocationChoice,
} from './editor-model.ts'
import { type OrganizationDiscountIds } from './editor-state-schema.ts'

export type DiscountEditorData = {
	catalog: LoyaltyCatalog
	choices: DiscountChoiceCatalog
	locations: DiscountLocationChoice[]
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
		[organization],
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
		db
			.select({
				siteLocales: Organization.siteLocales,
				siteDefaultLocale: Organization.siteDefaultLocale,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1),
	])
	const { defaultLocale } = parseSiteLocalesConfig(
		organization?.siteLocales,
		organization?.siteDefaultLocale,
	)

	const groupName = new Map(
		groups.map((group) => [
			group.id,
			group.name.trim() || group.internalName?.trim() || group.id,
		]),
	)
	// An option is shown with the group it sits in, so two "Extra cheese"
	// options in different groups can be told apart.
	const groupsOfOption = new Map<string, string[]>()
	for (const row of assignments) {
		const name = groupName.get(row.groupId)
		if (!name) continue
		groupsOfOption.set(row.optionId, [
			...(groupsOfOption.get(row.optionId) ?? []),
			name,
		])
	}

	return {
		catalog,
		locations,
		choices: {
			sizes: sizeChoices(itemVariations),
			groups: groups.map((group) => ({
				id: group.id,
				name: groupName.get(group.id)!,
				detail: null,
			})),
			options: options.map((option) => ({
				id: option.id,
				name:
					getLocalizedMenuValue(
						option.displayName,
						defaultLocale,
						defaultLocale,
					).trim() ||
					option.internalName?.trim() ||
					option.id,
				detail: groupsOfOption.get(option.id)?.join(', ') ?? null,
			})),
		},
	}
}

/** Most size names the picker offers. */
const MAX_SIZE_CHOICES = 200

/**
 * Every size name ("Large", "Thin crust") used by a variation across the menu,
 * the most used first. A size has a different id on each item but the same
 * name, which is what a discount matches on.
 */
function sizeChoices(
	rows: ReadonlyArray<{ variations: string | null }>,
): DiscountChoiceCatalog['sizes'] {
	const counts = new Map<string, { name: string; items: number }>()
	for (const row of rows) {
		const names = new Set<string>()
		for (const group of parseMenuVariations(row.variations).groups) {
			for (const value of group.values) {
				const name = value.name.trim()
				if (name) names.add(name)
			}
		}
		for (const name of names) {
			const key = name.toLowerCase()
			const entry = counts.get(key) ?? { name, items: 0 }
			entry.items += 1
			counts.set(key, entry)
		}
	}
	return [...counts.values()]
		.sort((a, b) => b.items - a.items || a.name.localeCompare(b.name))
		.slice(0, MAX_SIZE_CHOICES)
		.map((entry) => ({ id: entry.name, name: entry.name, detail: null }))
}
