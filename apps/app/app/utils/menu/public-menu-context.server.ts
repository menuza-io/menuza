/**
 * Fresh public site menu builder.
 *
 * Extracted from `resources+/sites.menu.ts` so internal consumers
 * (`resources+/order-context.ts`, used by the regional tenant service to
 * revalidate restaurant orders) can read the authoritative catalog directly
 * from the control-plane database, bypassing the published-site KV cache.
 *
 * Contains no customer PII: only public org, location, menu, and pricing data.
 */

import { cashDiscountAllowedIn } from '@repo/common/cash-discount'
import { readCourseSettings } from '@repo/common/kitchen-ticket'
import {
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_FULFILLMENT_OPTIONS,
	DEFAULT_IN_HOUSE_TIPS,
	DEFAULT_SCHEDULING,
	DEFAULT_WEEKLY_SCHEDULE,
	getLocationCurrency,
	type DeliveryConfig,
	type DeliveryZone,
	type FulfillmentOptions,
	type InHouseTips,
	type LocationAddress,
	type SchedulingOptions,
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import {
	isSoldOn,
	parseMenuChannels,
	type MenuChannel,
} from '@repo/common/menu-channels'
import { type MenuPricingRule } from '@repo/common/menu-pricing'
import {
	isUnavailableUntilExpired,
	parseMenuItemImageKeys,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	parseOrderNumberFormat,
	parsePosLocationStationSettings,
	type PosLocationStationSettings,
} from '@repo/common/pos-orders'
import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	lte,
	ne,
	or,
	Organization,
	OrganizationLocation,
	OrganizationMediaAsset,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import { type OrderContextDiscounts } from '@repo/discounts'
import { type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
	buildPublicMenuDiscounts,
	type PublicMenuPromotion,
} from '#app/utils/discounts/order-context.server.ts'
import { publicOrderingControls } from '#app/utils/location/ordering-pause.ts'
import { isDailyDishLimitsEnabled } from '#app/utils/orders/daily-dish-limits.server.ts'
import { isSlotLimitsEnabled } from '#app/utils/orders/slot-limits.server.ts'
import { isUpsellEnabled } from '#app/utils/orders/upsell-flag.server.ts'
import { loadPublishedPricingRules } from './pricing-rules.server.ts'
import { secondsUntilNextRuleChange } from './pricing-rules.ts'
import {
	applyOptionAssignment,
	attachNestedModifierGroups,
	effectiveAvailabilityStatus,
	getNextVariationExpiry,
	safeJsonParse,
	serializePublicMenuItem,
	serializePublicModifierGroup,
	serializePublicOption,
	type PublicLocationData,
	type PublicMenuCategoryData,
	type PublicMenuItemData,
	type PublicMenuData,
	type PublicMenuOptionData,
	type PublicModifierGroupData,
} from './public-serializers.server.ts'

/**
 * A location's Station settings as the till reads them. The cash-payment
 * discount (#375) is part of them only where the organization's data region
 * allows it: elsewhere the till never sees a rate, even one saved before the
 * organization moved region.
 */
export function tillStationSettings(
	raw: unknown,
	dataRegion: string | null | undefined,
): PosLocationStationSettings {
	const settings = parsePosLocationStationSettings(raw)
	return cashDiscountAllowedIn(dataRegion)
		? settings
		: { ...settings, cashDiscountBp: null }
}

export type { PublicMenuPromotion } from '#app/utils/discounts/order-context.server.ts'
export type {
	PublicLocationData,
	PublicMenuCategoryData,
	PublicMenuItemData,
	PublicMenuData,
	PublicMenuOptionData,
	PublicModifierGroupData,
} from './public-serializers.server.ts'

export interface PublicSiteMenuPayload {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
		defaultLocale: string
		locales: string[]
	}
	locations: PublicLocationData[]
	menus: PublicMenuData[]
	locationOverrides: Record<
		string,
		Array<{
			entityType: string
			entityId: string
			isEnabled?: boolean | null
			price?: number | null
			availabilityStatus?: string | null
			channels?: MenuChannel[] | null
		}>
	>
	/** Banners and item badges. Absent on a cached menu from before discounts. */
	promotions?: PublicMenuPromotion[]
	/**
	 * Live percentage pricing rules (#388), in priority order. Every channel
	 * prices a dish with `resolveMenuItemPrice` from `@repo/common/menu-pricing`.
	 * Absent when the organization has none (and on older cached menus).
	 */
	pricingRules?: MenuPricingRule[]
	/**
	 * Site features the menu page reads (#114): `upsell` is the
	 * `ordering.upsell` flag. Absent on a cached menu from before it, which
	 * Sites reads as off.
	 */
	features?: {
		upsell: boolean
		slotLimits?: boolean
		/**
		 * `ordering.daily_dish_limits` (#409): a hint only, so a menu page of an
		 * organization without daily limits skips the call that reads them. The
		 * cap itself is never in this payload.
		 */
		dailyDishLimits?: boolean
	}
	/**
	 * Not part of the public response. Till rules are loaded by a paired
	 * terminal. The field stays so an older snapshot still type-checks.
	 */
	discountRules?: OrderContextDiscounts['discounts']
}

/** Org fields the menu builder needs; no PII. */
export interface PublicSiteMenuOrgContext {
	id: string
	name: string
	slug: string
	/** Org-level fallback currency ('USD' | 'SAR'). */
	currency: string
	siteDefaultLocale: string | null
	siteLocales: string | null
	customDomain: string | null
}

/**
 * Build the public site menu payload from the live control-plane database.
 * Never reads or writes the site KV cache. `locationId` optionally picks the
 * currency-bearing location in `organization.currency` (and filters location
 * channel overrides when `buildOptions.channel` is provided).
 */
export async function buildPublicSiteMenuPayload(
	org: PublicSiteMenuOrgContext,
	locationId: string | null,
	buildOptions?: { channel?: MenuChannel },
): Promise<{
	payload: PublicSiteMenuPayload
	/**
	 * Seconds until the next item variation returns from a timed hold, or null.
	 * Public callers shorten their cache TTL with it.
	 */
	secondsUntilVariationReturn: number | null
}> {
	const orgId = org.id

	// 1. Fetch Locations
	const rawLocations = await db
		.select()
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, orgId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)

	// Ready texts need an SMS route: the US data region only (KSA waits for an
	// in-kingdom provider), so a KSA organization never shows the field.
	const orgRegionRow = await db
		.select({ dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.id, orgId))
		.limit(1)
	const dataRegion = orgRegionRow[0]?.dataRegion ?? 'us'
	const textsGuests =
		rawLocations.some((loc) => loc.readyTextEnabled) && dataRegion === 'us'

	const locations: PublicLocationData[] = rawLocations.map((loc) => {
		const parsedAddress = safeJsonParse<LocationAddress | null>(
			loc.address,
			null,
		)
		return {
			id: loc.id,
			name: loc.name,
			slug: loc.slug,
			phone: loc.phone,
			timezone: loc.timezone || 'UTC',
			taxRate: loc.taxRate || 0,
			taxInclusive: Boolean(loc.taxInclusive),
			vatNumber: loc.vatNumber?.trim() || null,
			address: parsedAddress,
			currency:
				org.currency === 'SAR' ? 'SAR' : getLocationCurrency(parsedAddress),
			storeHours: safeJsonParse<WeeklySchedule>(
				loc.storeHours,
				DEFAULT_WEEKLY_SCHEDULE,
			),
			onlineHours: safeJsonParse<WeeklySchedule>(
				loc.onlineHours,
				DEFAULT_WEEKLY_SCHEDULE,
			),
			specialHours: safeJsonParse<SpecialHour[]>(loc.specialHours, []),
			prepTime: loc.prepTime || 15,
			fulfillmentOptions: safeJsonParse<FulfillmentOptions>(
				loc.fulfillmentOptions,
				DEFAULT_FULFILLMENT_OPTIONS,
			),
			inHouseTips: safeJsonParse<InHouseTips>(
				loc.inHouseTips,
				DEFAULT_IN_HOUSE_TIPS,
			),
			tipSettings: safeJsonParse<unknown>(loc.tipSettings, null),
			scheduling: safeJsonParse<SchedulingOptions>(
				loc.scheduling,
				DEFAULT_SCHEDULING,
			),
			deliveryConfig: safeJsonParse<DeliveryConfig>(
				loc.deliveryConfig,
				DEFAULT_DELIVERY_CONFIG,
			),
			deliveryZones: safeJsonParse<DeliveryZone[]>(loc.deliveryZones, []),
			isDefault: Boolean(loc.isDefault),
			readyText: textsGuests && Boolean(loc.readyTextEnabled),
			courses: readCourseSettings(safeJsonParse(loc.courseSettings, null)),
			...publicOrderingControls(loc, new Date()),
			onlineOrderingSettings: safeJsonParse(loc.onlineOrderingSettings, null),
			slotLimitSettings: safeJsonParse(loc.slotLimitSettings, null),
			prepSchedule: safeJsonParse(loc.prepSchedule, null),
			prayerPauseSettings: safeJsonParse(loc.prayerPauseSettings, null),
			prayerPauseRegion: dataRegion === 'ksa',
			stationSettings: tillStationSettings(loc.stationSettings, dataRegion),
			...(loc.orderNumberFormat
				? { orderNumberFormat: parseOrderNumberFormat(loc.orderNumberFormat) }
				: {}),
		}
	})

	const now = new Date()
	const isEntityAvailable = (
		statusCol: AnySQLiteColumn,
		untilCol: AnySQLiteColumn,
	) =>
		or(
			eq(statusCol, 'available'),
			and(
				or(
					eq(statusCol, 'unavailable_until'),
					eq(statusCol, 'unavailable_until_tomorrow'),
				),
				lte(untilCol, now),
			),
		)

	// 2. Fetch Menus
	const menus = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, orgId),
				ne(OrganizationMenu.menuType, 'drop'),
				isEntityAvailable(
					OrganizationMenu.availabilityStatus,
					OrganizationMenu.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenu.position))

	// 3. Fetch Categories
	const categories = await db
		.select()
		.from(OrganizationMenuCategory)
		.where(
			and(
				eq(OrganizationMenuCategory.organizationId, orgId),
				isEntityAvailable(
					OrganizationMenuCategory.availabilityStatus,
					OrganizationMenuCategory.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenuCategory.position))

	// 4. Fetch Menu <-> Category Assignments (scoped to this org's menus)
	const menuCategoryAssignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(
			inArray(
				OrganizationMenuCategoryAssignment.menuId,
				menus.map((menu) => menu.id),
			),
		)
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))

	// 5. Fetch Items
	const items = await db
		.select()
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, orgId),
				isEntityAvailable(
					OrganizationMenuItem.availabilityStatus,
					OrganizationMenuItem.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenuItem.position))

	// 6. Fetch Category <-> Item Assignments (scoped to this org's categories)
	const categoryItemAssignments = await db
		.select()
		.from(OrganizationMenuItemCategoryAssignment)
		.where(
			inArray(
				OrganizationMenuItemCategoryAssignment.categoryId,
				categories.map((category) => category.id),
			),
		)
		.orderBy(asc(OrganizationMenuItemCategoryAssignment.position))

	// 7. Fetch Modifier Groups
	const modifierGroups = await db
		.select()
		.from(OrganizationMenuModifierGroup)
		.where(
			and(
				eq(OrganizationMenuModifierGroup.organizationId, orgId),
				isEntityAvailable(
					OrganizationMenuModifierGroup.availabilityStatus,
					OrganizationMenuModifierGroup.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenuModifierGroup.position))

	// 8. Fetch Item <-> Modifier Group Assignments (scoped to this org's items)
	const itemModifierAssignments = await db
		.select()
		.from(OrganizationMenuItemModifierGroupAssignment)
		.where(
			inArray(
				OrganizationMenuItemModifierGroupAssignment.itemId,
				items.map((item) => item.id),
			),
		)
		.orderBy(asc(OrganizationMenuItemModifierGroupAssignment.position))

	// 9. Fetch Options & Assignments
	const options = await db
		.select()
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.organizationId, orgId),
				isEntityAvailable(
					OrganizationMenuOption.availabilityStatus,
					OrganizationMenuOption.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenuOption.position))

	const groupOptionAssignments = await db
		.select()
		.from(OrganizationMenuModifierGroupOptionAssignment)
		.where(
			inArray(
				OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				modifierGroups.map((group) => group.id),
			),
		)
		.orderBy(asc(OrganizationMenuModifierGroupOptionAssignment.position))

	// 10. Fetch Location Overrides
	const overrides = await db
		.select()
		.from(OrganizationMenuLocationOverride)
		.where(eq(OrganizationMenuLocationOverride.organizationId, orgId))

	const locationOverridesMap: Record<
		string,
		Array<{
			entityType: string
			entityId: string
			isEnabled?: boolean | null
			price?: number | null
			availabilityStatus?: string | null
			channels?: MenuChannel[] | null
		}>
	> = {}
	for (const ov of overrides) {
		// `isUnavailableUntilExpired(null, ...)` returns true, so only coerce an
		// expired status when the override actually specifies one. Otherwise keep
		// `null` so the inherited (parent entity) status is left untouched.
		const effectiveStatus =
			ov.availabilityStatus &&
			isUnavailableUntilExpired(ov.availabilityStatus, ov.unavailableUntil, now)
				? 'available'
				: ov.availabilityStatus

		const parsedOverrideChannels =
			ov.channels !== null && ov.channels !== undefined
				? parseMenuChannels(ov.channels)
				: null

		locationOverridesMap[ov.locationId] ??= []
		locationOverridesMap[ov.locationId]?.push({
			entityType: ov.entityType,
			entityId: ov.entityId,
			isEnabled: ov.isEnabled,
			price: ov.price,
			availabilityStatus: effectiveStatus,
			...(parsedOverrideChannels !== null
				? { channels: parsedOverrideChannels }
				: {}),
		})
	}

	// 11. Resolve Images
	const allImageKeys = new Set<string>()
	for (const it of items) {
		for (const imageKey of parseMenuItemImageKeys(it.imageKeys, it.imageKey)) {
			allImageKeys.add(imageKey)
		}
		for (const variant of parseMenuVariations(it.variations).variants) {
			if (variant.imageKey) allImageKeys.add(variant.imageKey)
		}
	}
	for (const opt of options) {
		if (opt.imageKey) allImageKeys.add(opt.imageKey)
	}

	const mediaAssets =
		allImageKeys.size > 0
			? await db
					.select({
						id: OrganizationMediaAsset.id,
						objectKey: OrganizationMediaAsset.objectKey,
						updatedAt: OrganizationMediaAsset.updatedAt,
					})
					.from(OrganizationMediaAsset)
					.where(
						and(
							eq(OrganizationMediaAsset.organizationId, orgId),
							or(
								inArray(OrganizationMediaAsset.id, Array.from(allImageKeys)),
								inArray(
									OrganizationMediaAsset.objectKey,
									Array.from(allImageKeys),
								),
							),
						),
					)
			: []

	const mediaMap = new Map<string, string>()
	for (const m of mediaAssets) {
		const url = `/resources/images?mediaId=${encodeURIComponent(m.id)}&v=${m.updatedAt.getTime()}`
		mediaMap.set(m.id, url)
		mediaMap.set(m.objectKey, url)
	}

	// 12. Assemble Hierarchical Tree
	const optionsMap = new Map(
		options.map((opt) => [opt.id, serializePublicOption(opt, mediaMap, now)]),
	)

	const optionsByGroupId = new Map<string, PublicMenuOptionData[]>()
	for (const asgn of groupOptionAssignments) {
		const opt = optionsMap.get(asgn.optionId)
		if (opt) {
			const effectiveOpt = applyOptionAssignment(opt, asgn)
			if (!optionsByGroupId.has(asgn.modifierGroupId)) {
				optionsByGroupId.set(asgn.modifierGroupId, [])
			}
			optionsByGroupId.get(asgn.modifierGroupId)?.push(effectiveOpt)
		}
	}

	const groupsMap = new Map(
		modifierGroups.map((g) => [
			g.id,
			serializePublicModifierGroup(g, optionsByGroupId.get(g.id) ?? [], now),
		]),
	)

	attachNestedModifierGroups(groupsMap.values(), groupsMap)

	const groupsByItemId = new Map<string, PublicModifierGroupData[]>()
	for (const asgn of itemModifierAssignments) {
		const group = groupsMap.get(asgn.modifierGroupId)
		if (group) {
			if (!groupsByItemId.has(asgn.itemId)) {
				groupsByItemId.set(asgn.itemId, [])
			}
			groupsByItemId.get(asgn.itemId)?.push(group)
		}
	}

	let nextVariationExpiry: number | null = null
	const itemsMap = new Map(
		items.map((item) => {
			const expiresAt = getNextVariationExpiry(
				parseMenuVariations(item.variations),
				now,
			)
			if (expiresAt !== null)
				nextVariationExpiry = Math.min(
					nextVariationExpiry ?? expiresAt,
					expiresAt,
				)
			return [
				item.id,
				serializePublicMenuItem(
					item,
					groupsByItemId.get(item.id) ?? [],
					mediaMap,
					now,
				),
			]
		}),
	)

	const itemsByCategoryId = new Map<string, PublicMenuItemData[]>()
	for (const asgn of categoryItemAssignments) {
		const item = itemsMap.get(asgn.itemId)
		if (item) {
			if (!itemsByCategoryId.has(asgn.categoryId)) {
				itemsByCategoryId.set(asgn.categoryId, [])
			}
			itemsByCategoryId.get(asgn.categoryId)?.push(item)
		}
	}

	const categoriesMap = new Map(
		categories.map((cat) => [
			cat.id,
			{
				id: cat.id,
				displayName: cat.displayName,
				internalName: cat.internalName,
				defaultCourseId: cat.defaultCourseId,
				description: cat.description,
				parentId: cat.parentId ?? null,
				subcategories: [] as PublicMenuCategoryData[],
				upsellCategoryIds: safeJsonParse<string[]>(cat.upsellCategoryIds, []),
				availabilityStatus: effectiveAvailabilityStatus(
					cat.availabilityStatus,
					cat.unavailableUntil,
					now,
				),
				channels: parseMenuChannels(cat.channels),
				position: cat.position,
				excludeFromOrderLimits: Boolean(cat.excludeFromOrderLimits),
				items: itemsByCategoryId.get(cat.id) ?? [],
			} satisfies PublicMenuCategoryData,
		]),
	)

	for (const cat of categoriesMap.values()) {
		if (cat.parentId) {
			const parent = categoriesMap.get(cat.parentId)
			if (parent) {
				parent.subcategories = parent.subcategories ?? []
				parent.subcategories.push(cat)
			}
		}
	}

	const categoriesByMenuId = new Map<string, PublicMenuCategoryData[]>()
	for (const asgn of menuCategoryAssignments) {
		const cat = categoriesMap.get(asgn.categoryId)
		if (cat) {
			if (!categoriesByMenuId.has(asgn.menuId)) {
				categoriesByMenuId.set(asgn.menuId, [])
			}
			categoriesByMenuId.get(asgn.menuId)?.push(cat)
		}
	}

	const allStructuredMenus: PublicMenuData[] = menus.map((menu) => ({
		id: menu.id,
		displayName: menu.displayName,
		internalName: menu.internalName,
		menuType: menu.menuType,
		nutritionalInfo: Boolean(menu.nutritionalInfo),
		specialInstructions: Boolean(menu.specialInstructions),
		availabilityStatus: effectiveAvailabilityStatus(
			menu.availabilityStatus,
			menu.unavailableUntil,
			now,
		),
		channels: parseMenuChannels(menu.channels),
		position: menu.position,
		categories: categoriesByMenuId.get(menu.id) ?? [],
	}))

	const channel = buildOptions?.channel
	const overrideByEntityId =
		channel && locationId
			? new Map(
					(locationOverridesMap[locationId] ?? []).map((ov) => [
						ov.entityId,
						ov,
					]),
				)
			: null
	const categoryAllowedOnChannel = (cat: PublicMenuCategoryData): boolean => {
		if (!channel) return true
		const visited = new Set<string>()
		let current: PublicMenuCategoryData | undefined = cat
		while (current && !visited.has(current.id)) {
			visited.add(current.id)
			if (
				!isSoldOn(channel, {
					category: current,
					override: overrideByEntityId?.get(current.id),
				})
			) {
				return false
			}
			current = current.parentId
				? categoriesMap.get(current.parentId)
				: undefined
		}
		return true
	}
	const filterCategoryForChannel = (
		cat: PublicMenuCategoryData,
	): PublicMenuCategoryData | null => {
		if (!channel) return cat
		if (!categoryAllowedOnChannel(cat)) return null
		return {
			...cat,
			items: cat.items.filter((item) =>
				isSoldOn(channel, {
					item,
					override: overrideByEntityId?.get(item.id),
				}),
			),
			subcategories: (cat.subcategories ?? [])
				.map(filterCategoryForChannel)
				.filter((sub): sub is PublicMenuCategoryData => sub !== null),
		}
	}

	const structuredMenus = channel
		? allStructuredMenus
				.filter((menu) =>
					isSoldOn(channel, {
						menu,
						override: overrideByEntityId?.get(menu.id),
					}),
				)
				.map((menu) => ({
					...menu,
					categories: menu.categories
						.map(filterCategoryForChannel)
						.filter((cat): cat is PublicMenuCategoryData => cat !== null),
				}))
		: allStructuredMenus

	const activeLocation =
		(locationId ? locations.find((l) => l.id === locationId) : undefined) ||
		locations.find((l) => l.isDefault) ||
		locations[0]

	const menuDiscounts = await buildPublicMenuDiscounts(org.id)
	const pricingRules = await loadPublishedPricingRules(org.id, now)
	const payload: PublicSiteMenuPayload = {
		organization: {
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency: activeLocation?.currency || org.currency || 'USD',
			defaultLocale: org.siteDefaultLocale || 'en',
			locales: safeJsonParse<string[]>(org.siteLocales, ['en']),
		},
		locations,
		menus: structuredMenus,
		locationOverrides: locationOverridesMap,
		promotions: menuDiscounts.promotions,
		...(pricingRules.length > 0 ? { pricingRules } : {}),
		features: {
			upsell: await isUpsellEnabled(org.id),
			slotLimits: await isSlotLimitsEnabled(org.id),
			dailyDishLimits: await isDailyDishLimitsEnabled(org.id),
		},
	}

	const variationSeconds =
		nextVariationExpiry === null
			? null
			: Math.ceil((nextVariationExpiry - now.getTime()) / 1000)
	// A pricing rule that starts or ends later shortens the cache the same way.
	const ruleSeconds = secondsUntilNextRuleChange(pricingRules, now)
	const secondsUntilVariationReturn =
		variationSeconds === null
			? ruleSeconds
			: ruleSeconds === null
				? variationSeconds
				: Math.min(variationSeconds, ruleSeconds)

	return { payload, secondsUntilVariationReturn }
}
