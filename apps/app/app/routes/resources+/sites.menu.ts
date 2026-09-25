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
	isUnavailableUntilExpired,
	parseMenuItemImageKeys,
} from '@repo/common/menu-types'
import {
	and,
	asc,
	desc,
	db,
	eq,
	inArray,
	lte,
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
import { getClientIp } from '@repo/security'
import { type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	getCachedSiteData,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'

export interface PublicLocationData {
	id: string
	name: string
	slug: string
	phone: string | null
	timezone: string
	taxRate: number
	address: LocationAddress | null
	currency: 'USD' | 'CAD'
	storeHours: WeeklySchedule
	onlineHours: WeeklySchedule
	specialHours: SpecialHour[]
	prepTime: number
	fulfillmentOptions: FulfillmentOptions
	inHouseTips: InHouseTips
	scheduling: SchedulingOptions
	deliveryConfig: DeliveryConfig
	deliveryZones: DeliveryZone[]
	isDefault: boolean
}

export interface PublicMenuOptionData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	imageKey: string | null
	imageUrl: string | null
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	calories: number | null
	minSelections: number
	maxSelections: number | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	isTopping: boolean
	isDefault: boolean
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	position: number
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupData[]
}

export interface PublicModifierGroupData {
	id: string
	name: string
	internalName: string | null
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	position: number
	options: PublicMenuOptionData[]
}

export interface PublicMenuItemData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	price: number
	imageKey: string | null
	imageUrl: string | null
	imageKeys: string[]
	imageUrls: string[]
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
	position: number
	modifierGroups: PublicModifierGroupData[]
}

export interface PublicMenuCategoryData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	parentId?: string | null
	subcategories?: PublicMenuCategoryData[]
	upsellCategoryIds: string[]
	availabilityStatus: string
	position: number
	items: PublicMenuItemData[]
}

export interface PublicMenuData {
	id: string
	displayName: string
	internalName: string | null
	menuType: string
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus: string
	position: number
	categories: PublicMenuCategoryData[]
}

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
		}>
	>
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

/**
 * Public endpoint for fetching an organization's restaurant menus, active locations,
 * categories, items, modifiers, and options with edge KV caching.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const locationId = url.searchParams.get('locationId') || null
	// Accept both `preview=1` (sent by apps/sites) and `preview=true`.
	const previewParam = url.searchParams.get('preview')
	const wantsPreview = previewParam === '1' || previewParam === 'true'

	if (!slug && !host) {
		throw new Response('Not Found', { status: 404 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		PUBLIC_SITE_RATE_LIMIT,
	)

	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	// 1. Resolve organization
	type OrgSelect = {
		id: string
		name: string
		slug: string
		siteDefaultLocale: string | null
		siteLocales: string | null
		customDomain: string | null
		currency: string
	}
	let org: OrgSelect | undefined
	if (slug) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.slug, slug),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
				),
			)
			.limit(1)
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	} else if (host) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.customDomain, host),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
					inArray(Organization.customDomainStatus, ['active', 'pending']),
				),
			)
			.limit(1)
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	}

	if (!org) {
		throw new Response('Not Found', { status: 404 })
	}

	// `preview` bypasses the edge KV cache, which forces an uncached full menu
	// scan. Only honour it when the request presents the organization's own
	// custom domain via the `host` signal this route already trusts to resolve a
	// custom-domain org, so an anonymous `?preview=1` cannot trigger it.
	const isPreview =
		wantsPreview && Boolean(host) && org.customDomain?.toLowerCase() === host

	const orgId = org.id
	const queryHash = locationId || 'all'
	const cacheKey = getSiteKvKey('page', orgId, `menu-${queryHash}`)

	// Check KV Cache
	if (!isPreview) {
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Accept-Language',
				},
			})
		}
	}

	// 2. Fetch Locations
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
			address: parsedAddress,
			currency: getLocationCurrency(parsedAddress),
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

	// 3. Fetch Menus
	const menus = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, orgId),
				isEntityAvailable(
					OrganizationMenu.availabilityStatus,
					OrganizationMenu.unavailableUntil,
				),
			),
		)
		.orderBy(asc(OrganizationMenu.position))

	// 4. Fetch Categories
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

	// 5. Fetch Menu <-> Category Assignments (scoped to this org's menus)
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

	// 6. Fetch Items
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

	// 7. Fetch Category <-> Item Assignments (scoped to this org's categories)
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

	// 8. Fetch Modifier Groups
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

	// 9. Fetch Item <-> Modifier Group Assignments (scoped to this org's items)
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

	// 10. Fetch Options & Assignments
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

	// 11. Fetch Location Overrides
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

		locationOverridesMap[ov.locationId] ??= []
		locationOverridesMap[ov.locationId]?.push({
			entityType: ov.entityType,
			entityId: ov.entityId,
			isEnabled: ov.isEnabled,
			price: ov.price,
			availabilityStatus: effectiveStatus,
		})
	}

	// 12. Resolve Images
	const allImageKeys = new Set<string>()
	for (const it of items) {
		for (const imageKey of parseMenuItemImageKeys(it.imageKeys, it.imageKey)) {
			allImageKeys.add(imageKey)
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

	// 13. Assemble Hierarchical Tree
	// Options Map
	const optionsMap = new Map(
		options.map((opt) => [
			opt.id,
			{
				id: opt.id,
				displayName: opt.displayName,
				internalName: opt.internalName,
				description: opt.description,
				imageKey: opt.imageKey,
				imageUrl: opt.imageKey ? (mediaMap.get(opt.imageKey) ?? null) : null,
				price: opt.price,
				priceWhole: opt.priceWhole,
				priceLeft: opt.priceLeft,
				priceRight: opt.priceRight,
				calories: opt.calories,
				minSelections: opt.minSelections,
				maxSelections: opt.maxSelections,
				isAlcohol: Boolean(opt.isAlcohol),
				isGlutenFree: Boolean(opt.isGlutenFree),
				isVegetarian: Boolean(opt.isVegetarian),
				isTopping: Boolean(opt.isTopping),
				isDefault: false,
				nestedModifierGroupIds: safeJsonParse<string[]>(
					opt.nestedModifierGroupIds,
					[],
				),
				allergens: safeJsonParse<string[]>(opt.allergens, []),
				applySalesTax: Boolean(opt.applySalesTax),
				availabilityStatus: isUnavailableUntilExpired(
					opt.availabilityStatus,
					opt.unavailableUntil,
					now,
				)
					? 'available'
					: opt.availabilityStatus,
				position: opt.position,
			} satisfies PublicMenuOptionData,
		]),
	)

	// Group -> Options
	const optionsByGroupId = new Map<string, PublicMenuOptionData[]>()
	for (const asgn of groupOptionAssignments) {
		const opt = optionsMap.get(asgn.optionId)
		if (opt) {
			const effectiveOpt = {
				...opt,
				price: asgn.priceOverride ?? opt.price,
				priceWhole: asgn.priceWholeOverride ?? opt.priceWhole,
				priceLeft: asgn.priceLeftOverride ?? opt.priceLeft,
				priceRight: asgn.priceRightOverride ?? opt.priceRight,
				isDefault: Boolean(asgn.isDefault),
			}
			if (!optionsByGroupId.has(asgn.modifierGroupId)) {
				optionsByGroupId.set(asgn.modifierGroupId, [])
			}
			optionsByGroupId.get(asgn.modifierGroupId)?.push(effectiveOpt)
		}
	}

	// Modifier Groups Map
	const groupsMap = new Map(
		modifierGroups.map((g) => [
			g.id,
			{
				id: g.id,
				name: g.name,
				internalName: g.internalName,
				selectionType: g.selectionType as
					'single' | 'multiple' | 'quantity' | 'pizza',
				minSelections: g.minSelections,
				maxSelections: g.maxSelections,
				availabilityStatus: isUnavailableUntilExpired(
					g.availabilityStatus,
					g.unavailableUntil,
					now,
				)
					? 'available'
					: g.availabilityStatus,
				position: g.position,
				options: optionsByGroupId.get(g.id) ?? [],
			} satisfies PublicModifierGroupData,
		]),
	)

	// Attach nestedModifierGroups to each option
	for (const group of groupsMap.values()) {
		for (const opt of group.options) {
			if (opt.nestedModifierGroupIds && opt.nestedModifierGroupIds.length > 0) {
				opt.nestedModifierGroups = opt.nestedModifierGroupIds
					.map((gId) => groupsMap.get(gId))
					.filter(Boolean) as PublicModifierGroupData[]
			}
		}
	}

	// Item -> Modifier Groups
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

	// Items Map
	const itemsMap = new Map(
		items.map((item) => {
			const imageKeys = parseMenuItemImageKeys(item.imageKeys, item.imageKey)
			const imageUrls = imageKeys.flatMap((imageKey) => {
				const imageUrl = mediaMap.get(imageKey)
				return imageUrl ? [imageUrl] : []
			})

			return [
				item.id,
				{
					id: item.id,
					displayName: item.displayName,
					internalName: item.internalName,
					description: item.description,
					price: item.price,
					imageKey: imageKeys[0] ?? null,
					imageUrl: imageUrls[0] ?? null,
					imageKeys,
					imageUrls,
					isAlcohol: Boolean(item.isAlcohol),
					isGlutenFree: Boolean(item.isGlutenFree),
					isVegetarian: Boolean(item.isVegetarian),
					allergens: safeJsonParse<string[]>(item.allergens, []),
					calorieMin: item.calorieMin,
					calorieMax: item.calorieMax,
					isPopular: Boolean(item.isPopular),
					isUpsell: Boolean(item.isUpsell),
					availabilityStatus: isUnavailableUntilExpired(
						item.availabilityStatus,
						item.unavailableUntil,
						now,
					)
						? 'available'
						: item.availabilityStatus,
					position: item.position,
					modifierGroups: groupsByItemId.get(item.id) ?? [],
				} satisfies PublicMenuItemData,
			]
		}),
	)

	// Category -> Items
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

	// Categories Map
	const categoriesMap = new Map(
		categories.map((cat) => [
			cat.id,
			{
				id: cat.id,
				displayName: cat.displayName,
				internalName: cat.internalName,
				description: cat.description,
				parentId: cat.parentId ?? null,
				subcategories: [] as PublicMenuCategoryData[],
				upsellCategoryIds: safeJsonParse<string[]>(cat.upsellCategoryIds, []),
				availabilityStatus: isUnavailableUntilExpired(
					cat.availabilityStatus,
					cat.unavailableUntil,
					now,
				)
					? 'available'
					: cat.availabilityStatus,
				position: cat.position,
				items: itemsByCategoryId.get(cat.id) ?? [],
			} satisfies PublicMenuCategoryData,
		]),
	)

	// Link subcategories in categoriesMap
	for (const cat of categoriesMap.values()) {
		if (cat.parentId) {
			const parent = categoriesMap.get(cat.parentId)
			if (parent) {
				parent.subcategories = parent.subcategories ?? []
				parent.subcategories.push(cat)
			}
		}
	}

	// Menu -> Categories
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

	// Final Menus List
	const structuredMenus: PublicMenuData[] = menus.map((menu) => ({
		id: menu.id,
		displayName: menu.displayName,
		internalName: menu.internalName,
		menuType: menu.menuType,
		nutritionalInfo: Boolean(menu.nutritionalInfo),
		specialInstructions: Boolean(menu.specialInstructions),
		availabilityStatus: isUnavailableUntilExpired(
			menu.availabilityStatus,
			menu.unavailableUntil,
			now,
		)
			? 'available'
			: menu.availabilityStatus,
		position: menu.position,
		categories: categoriesByMenuId.get(menu.id) ?? [],
	}))

	const activeLocation =
		(locationId ? locations.find((l) => l.id === locationId) : undefined) ||
		locations.find((l) => l.isDefault) ||
		locations[0]

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
	}

	if (!isPreview) {
		await setCachedSiteData(cacheKey, payload)
	}

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			Vary: 'Accept-Language',
		},
	})
}
