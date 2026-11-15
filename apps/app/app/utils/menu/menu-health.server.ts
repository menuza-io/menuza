import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	inArray,
	MenuCheckDismissal,
	not,
	like,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import {
	computeMenuHealth,
	menuHealthCheckIds,
	summarizeMenuHealth,
	type MenuHealth,
	type MenuHealthCategory,
	type MenuHealthCheckKey,
	type MenuHealthDismissal,
	type MenuHealthInput,
	type MenuHealthItem,
	type MenuHealthModifierGroup,
	type MenuHealthSummary,
} from './menu-health.ts'

export const MENU_HEALTH_ITEM_COLUMNS = {
	id: OrganizationMenuItem.id,
	displayName: OrganizationMenuItem.displayName,
	description: OrganizationMenuItem.description,
	price: OrganizationMenuItem.price,
	imageKey: OrganizationMenuItem.imageKey,
	imageUrl: OrganizationMenuItem.imageUrl,
	imageKeys: OrganizationMenuItem.imageKeys,
	variations: OrganizationMenuItem.variations,
	allergens: OrganizationMenuItem.allergens,
	calorieMin: OrganizationMenuItem.calorieMin,
	calorieMax: OrganizationMenuItem.calorieMax,
	availabilityStatus: OrganizationMenuItem.availabilityStatus,
	unavailableUntil: OrganizationMenuItem.unavailableUntil,
	updatedAt: OrganizationMenuItem.updatedAt,
}

type HealthOrganization = {
	id: string
	siteLocales: string | null
	siteDefaultLocale: string | null
}

export type MenuHealthData = {
	items: Array<MenuHealthItem>
	categories: Array<MenuHealthCategory & { displayName: string }>
	categoryIdsWithItems: string[]
	modifierGroups: Array<MenuHealthModifierGroup & { name: string }>
	itemModifierGroups: Array<{ itemId: string; modifierGroupId: string }>
	modifierGroupOptions: Array<{
		modifierGroupId: string
		availabilityStatus: string
	}>
	dismissals: MenuHealthDismissal[]
}

/** Health dismissals of an organization; review-stack `card:` rows excluded. */
const healthDismissalRows = (organizationId: string) =>
	and(
		eq(MenuCheckDismissal.organizationId, organizationId),
		not(like(MenuCheckDismissal.checkKey, 'card:%')),
	)

/**
 * Everything the health checks read, for the whole organization (every
 * item, category and group, not only the menu tab on screen). Every query
 * is scoped by organization, so no list sized by the menu is bound.
 */
export async function loadMenuHealthData(
	organizationId: string,
): Promise<MenuHealthData> {
	const [
		items,
		categories,
		filledCategories,
		modifierGroups,
		itemModifierGroups,
		modifierGroupOptions,
		dismissals,
	] = await Promise.all([
		db
			.select(MENU_HEALTH_ITEM_COLUMNS)
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				parentId: OrganizationMenuCategory.parentId,
				availabilityStatus: OrganizationMenuCategory.availabilityStatus,
				displayName: OrganizationMenuCategory.displayName,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.selectDistinct({
				categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuModifierGroup.id,
				name: OrganizationMenuModifierGroup.name,
				selectionType: OrganizationMenuModifierGroup.selectionType,
				minSelections: OrganizationMenuModifierGroup.minSelections,
				maxSelections: OrganizationMenuModifierGroup.maxSelections,
				availabilityStatus: OrganizationMenuModifierGroup.availabilityStatus,
			})
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({
				itemId: OrganizationMenuItemModifierGroupAssignment.itemId,
				modifierGroupId:
					OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
			})
			.from(OrganizationMenuItemModifierGroupAssignment)
			.innerJoin(
				OrganizationMenuModifierGroup,
				eq(
					OrganizationMenuModifierGroup.id,
					OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
				),
			)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId)),
		db
			.select({
				modifierGroupId:
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				availabilityStatus: OrganizationMenuOption.availabilityStatus,
			})
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.innerJoin(
				OrganizationMenuOption,
				eq(
					OrganizationMenuOption.id,
					OrganizationMenuModifierGroupOptionAssignment.optionId,
				),
			)
			.where(eq(OrganizationMenuOption.organizationId, organizationId)),
		db
			.select({
				entityId: MenuCheckDismissal.entityId,
				checkKey: MenuCheckDismissal.checkKey,
				fingerprint: MenuCheckDismissal.fingerprint,
			})
			.from(MenuCheckDismissal)
			.where(healthDismissalRows(organizationId)),
	])
	return {
		items,
		categories,
		categoryIdsWithItems: filledCategories.map((row) => row.categoryId),
		modifierGroups,
		itemModifierGroups,
		modifierGroupOptions,
		dismissals,
	}
}

/**
 * Drop dismissals that no longer apply (the record passes, is hidden or
 * gone, or the field changed), so a problem that comes back counts again.
 * Never breaks the page: a failure is logged and the rows wait for the next
 * load.
 */
async function deleteStaleDismissals(
	organizationId: string,
	stale: MenuHealth['staleDismissals'],
) {
	if (stale.length === 0) return
	try {
		// Chunked: D1 allows 100 bound parameters per statement.
		for (let start = 0; start < stale.length; start += 40) {
			const chunk = stale.slice(start, start + 40)
			const byKey = new Map<MenuHealthCheckKey, string[]>()
			for (const row of chunk) {
				byKey.set(row.checkKey, [...(byKey.get(row.checkKey) ?? []), row.entityId])
			}
			for (const [checkKey, entityIds] of byKey) {
				await db
					.delete(MenuCheckDismissal)
					.where(
						and(
							eq(MenuCheckDismissal.organizationId, organizationId),
							eq(MenuCheckDismissal.checkKey, checkKey),
							inArray(MenuCheckDismissal.entityId, entityIds),
						),
					)
			}
		}
	} catch (error) {
		console.error('menu health: could not drop stale dismissals', {
			organizationId,
			error: error instanceof Error ? error.message : 'unknown',
		})
	}
}

/**
 * Score the whole organization's menu, with its dismissals. Callers must
 * have checked menu read access first.
 */
export async function loadMenuHealth(
	organization: HealthOrganization,
	options: { includeFingerprints?: boolean } = {},
): Promise<MenuHealth> {
	const { health } = await loadMenuHealthWithData(organization, options)
	return health
}

export async function loadMenuHealthWithData(
	organization: HealthOrganization,
	options: { includeFingerprints?: boolean } = {},
): Promise<{ health: MenuHealth; data: MenuHealthData }> {
	const data = await loadMenuHealthData(organization.id)
	const health = computeMenuHealthFor(organization, data, options)
	await deleteStaleDismissals(organization.id, health.staleDismissals)
	return { health, data }
}

/** The Menu overview's view of health: names per record, no fingerprints. */
export async function loadMenuHealthSummary(
	organization: HealthOrganization,
): Promise<MenuHealthSummary> {
	const { health, data } = await loadMenuHealthWithData(organization)
	const { defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const names = {
		item: new Map(data.items.map((row) => [row.id, row.displayName])),
		category: new Map(data.categories.map((row) => [row.id, row.displayName])),
		modifier_group: new Map(
			data.modifierGroups.map((row) => [row.id, row.name]),
		),
	}
	return summarizeMenuHealth(health, (entityType, id) =>
		pickLocalized(names[entityType].get(id) ?? '', defaultLocale, defaultLocale),
	)
}

/**
 * The ids one check lists right now, dismissals applied: what the filtered
 * Items, Categories and Modifier groups lists show for `?health=<key>`.
 */
export async function loadMenuHealthCheckIds(
	organization: HealthOrganization,
	key: MenuHealthCheckKey,
): Promise<string[]> {
	const health = await loadMenuHealth(organization)
	const check = health.checks.find((entry) => entry.key === key)
	return check ? menuHealthCheckIds(check) : []
}

export function computeMenuHealthFor(
	organization: {
		siteLocales: string | null
		siteDefaultLocale: string | null
	},
	data: Pick<
		MenuHealthInput,
		| 'items'
		| 'categories'
		| 'categoryIdsWithItems'
		| 'modifierGroups'
		| 'itemModifierGroups'
		| 'modifierGroupOptions'
		| 'dismissals'
	>,
	options: { includeFingerprints?: boolean; now?: Date } = {},
): MenuHealth {
	const { locales, defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	return computeMenuHealth({ ...data, ...options, locales, defaultLocale })
}
