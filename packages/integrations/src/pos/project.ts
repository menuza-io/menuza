/**
 * Projects a menuza menu into the canonical provider shapes (`RemoteItem[]`,
 * `RemoteMenu[]`). This is the bridge between the app's menu tables and the
 * wire codecs.
 */

import {
	focalCropUrl,
	focalPointOf,
	mediaIdOfUrl,
} from '@repo/common/image-focal'
import {
	isUnavailableUntilExpired,
	parseMenuVariations,
	type MenuVariations,
} from '@repo/common/menu-types'
import {
	OrganizationMediaAsset,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroupOptionAssignment,
	and,
	asc,
	db,
	eq,
	inArray,
} from '@repo/database'
import { PosError } from './errors.ts'
import { type RemoteItem, type RemoteMenu } from './types.ts'

export type SyncableMenu = {
	menu: { id: string; name: string }
	items: RemoteItem[]
	menus: RemoteMenu[]
}

export type SyncableMenus = {
	selectedMenus: Array<{ id: string; name: string }>
	items: RemoteItem[]
	menus: RemoteMenu[]
}

export type LoadMenuForSyncOptions = {
	locationId?: string | null
	now?: Date
}

/** Resolves a localized menu column (`{"en":"…"}`) to a plain string. */
export function localizedText(
	value: string | null | undefined,
	fallback = '',
): string {
	if (!value) return fallback
	if (value.startsWith('{')) {
		try {
			const parsed = JSON.parse(value) as Record<string, string>
			return parsed.en || Object.values(parsed).find(Boolean) || fallback
		} catch {
			return value
		}
	}
	return value
}

function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return []
	try {
		const parsed = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

/**
 * A dish photo with a focal point (#394) is pushed to delivery platforms as a
 * crop around that point, since the platform crops the photo it is given. A
 * photo without a point keeps the plain address.
 */
export async function applyFocalCrops<T extends { imageUrl: string | null }>(
	organizationId: string,
	items: T[],
): Promise<T[]> {
	const ids = [
		...new Set(
			items.flatMap((item) => {
				const id = mediaIdOfUrl(item.imageUrl)
				return id ? [id] : []
			}),
		),
	]
	if (ids.length === 0) return items
	const focals = new Map<string, { x: number; y: number }>()
	// D1 allows 100 bound parameters per statement.
	for (let start = 0; start < ids.length; start += 80) {
		const rows = await db
			.select({
				id: OrganizationMediaAsset.id,
				focalX: OrganizationMediaAsset.focalX,
				focalY: OrganizationMediaAsset.focalY,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.id, ids.slice(start, start + 80)),
				),
			)
		for (const row of rows) {
			const focal = focalPointOf(row)
			if (focal) focals.set(row.id, focal)
		}
	}
	if (focals.size === 0) return items
	return items.map((item) => {
		const id = mediaIdOfUrl(item.imageUrl)
		const focal = id ? focals.get(id) : undefined
		return focal
			? { ...item, imageUrl: focalCropUrl(item.imageUrl, focal) }
			: item
	})
}

/**
 * Loads a single menu (categories → items → modifier groups → options) as the
 * canonical items a provider would receive, applying per-location overrides
 * (`OrganizationMenuLocationOverride`) when `options.locationId` is given.
 */
export async function loadMenuForSync(
	organizationId: string,
	menuId: string,
	options?: LoadMenuForSyncOptions,
): Promise<SyncableMenu> {
	const now = options?.now ?? new Date()
	const locationId = options?.locationId?.trim() || null

	const menu = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, menuId),
				eq(OrganizationMenu.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0])

	if (!menu) throw new PosError('Menu not found.', 404)
	const menuName = localizedText(menu.displayName, 'Menu')

	const overrideByKey = new Map<
		string,
		typeof OrganizationMenuLocationOverride.$inferSelect
	>()
	if (locationId) {
		const overrideRows = await db
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.locationId, locationId),
				),
			)
		for (const row of overrideRows) {
			overrideByKey.set(`${row.entityType}:${row.entityId}`, row)
		}
	}

	const menuOverride = overrideByKey.get(`menu:${menu.id}`)
	if (menuOverride?.isEnabled === false) {
		return {
			menu: { id: menu.id, name: menuName },
			items: [],
			menus: [],
		}
	}
	const menuAvailable = menuOverride?.availabilityStatus
		? isUnavailableUntilExpired(
				menuOverride.availabilityStatus,
				menuOverride.unavailableUntil,
				now,
			)
		: true

	const categoryAssignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))
	const categoryIds = categoryAssignments
		.map((row) => row.categoryId)
		.filter(
			(categoryId) =>
				overrideByKey.get(`category:${categoryId}`)?.isEnabled !== false,
		)

	const itemRows = categoryIds.length
		? await db.query.OrganizationMenuItemCategoryAssignment.findMany({
				where: inArray(
					OrganizationMenuItemCategoryAssignment.categoryId,
					categoryIds,
				),
				orderBy: asc(OrganizationMenuItemCategoryAssignment.position),
				with: { category: true, item: true },
			})
		: []
	const itemIds = itemRows.map((row) => row.itemId)

	const groupRows = itemIds.length
		? await db.query.OrganizationMenuItemModifierGroupAssignment.findMany({
				where: inArray(
					OrganizationMenuItemModifierGroupAssignment.itemId,
					itemIds,
				),
				orderBy: asc(OrganizationMenuItemModifierGroupAssignment.position),
				with: { modifierGroup: true },
			})
		: []
	const groupIds = [...new Set(groupRows.map((row) => row.modifierGroupId))]

	const optionRows = groupIds.length
		? await db.query.OrganizationMenuModifierGroupOptionAssignment.findMany({
				where: inArray(
					OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
					groupIds,
				),
				orderBy: asc(OrganizationMenuModifierGroupOptionAssignment.position),
				with: { option: true },
			})
		: []

	const groupsByItem = new Map<string, typeof groupRows>()
	for (const row of groupRows) {
		const list = groupsByItem.get(row.itemId) ?? []
		list.push(row)
		groupsByItem.set(row.itemId, list)
	}
	const optionsByGroup = new Map<string, typeof optionRows>()
	for (const row of optionRows) {
		const list = optionsByGroup.get(row.modifierGroupId) ?? []
		list.push(row)
		optionsByGroup.set(row.modifierGroupId, list)
	}

	const items: RemoteItem[] = itemRows.flatMap(({ item, category }) => {
		if (!item || item.availabilityStatus === 'hidden') return []
		if (category?.availabilityStatus === 'hidden') return []
		const catOverride = category
			? overrideByKey.get(`category:${category.id}`)
			: undefined
		if (catOverride?.isEnabled === false) return []
		const itemOverride = overrideByKey.get(`item:${item.id}`)
		if (itemOverride?.isEnabled === false) return []

		const categoryGlobalAvailable = isUnavailableUntilExpired(
			category?.availabilityStatus,
			category?.unavailableUntil,
			now,
		)
		const categoryLocAvailable = catOverride?.availabilityStatus
			? isUnavailableUntilExpired(
					catOverride.availabilityStatus,
					catOverride.unavailableUntil,
					now,
				)
			: true
		const categoryAvailable = categoryGlobalAvailable && categoryLocAvailable

		const groups = (groupsByItem.get(item.id) ?? []).flatMap((assignment) => {
			const group = assignment.modifierGroup
			if (!group || group.availabilityStatus === 'hidden') return []
			const groupOverride = overrideByKey.get(`modifier_group:${group.id}`)
			if (groupOverride?.isEnabled === false) return []

			const groupGlobalAvailable = isUnavailableUntilExpired(
				group.availabilityStatus,
				group.unavailableUntil,
				now,
			)
			const groupLocAvailable = groupOverride?.availabilityStatus
				? isUnavailableUntilExpired(
						groupOverride.availabilityStatus,
						groupOverride.unavailableUntil,
						now,
					)
				: true
			const groupAvailable = groupGlobalAvailable && groupLocAvailable

			const mappedOptions = (optionsByGroup.get(group.id) ?? []).flatMap(
				(optionRow) => {
					const opt = optionRow.option
					if (!opt || opt.availabilityStatus === 'hidden') return []
					const optOverride = overrideByKey.get(`modifier_option:${opt.id}`)
					if (optOverride?.isEnabled === false) return []

					const baseOptionPrice = optionRow.priceOverride ?? opt.price ?? 0
					const effectiveOptionPrice =
						optOverride?.price !== null && optOverride?.price !== undefined
							? optOverride.price
							: baseOptionPrice

					const globalOptAvailable = isUnavailableUntilExpired(
						opt.availabilityStatus,
						opt.unavailableUntil,
						now,
					)
					const locOptAvailable = optOverride?.availabilityStatus
						? isUnavailableUntilExpired(
								optOverride.availabilityStatus,
								optOverride.unavailableUntil,
								now,
							)
						: true

					return [
						{
							name: localizedText(opt.displayName, 'Option'),
							price: Math.round(effectiveOptionPrice * 100),
							available:
								groupAvailable && globalOptAvailable && locOptAvailable,
						},
					]
				},
			)
			const max = group.maxSelections ?? Math.max(mappedOptions.length, 1)
			const min = Math.min(group.minSelections ?? 0, mappedOptions.length)
			return [
				{
					name: localizedText(group.name, 'Options'),
					min,
					max,
					options: mappedOptions,
				},
			]
		})

		const allergens = [
			...parseStringArray(item.allergens),
			...(item.isVegetarian ? ['vegetarian'] : []),
			...(item.isGlutenFree ? ['gluten-free'] : []),
		]

		const menuVariations = parseMenuVariations(item.variations)
		const remoteVariations = projectMenuVariations(menuVariations, now)
		const availableVariants = menuVariations.variants.filter((variant) =>
			isUnavailableUntilExpired(
				variant.availabilityStatus,
				variant.unavailableUntil,
				now,
			),
		)
		const basePriceCents = availableVariants.length
			? Math.round(
					Math.min(...availableVariants.map((variant) => variant.price)) * 100,
				)
			: Math.round(item.price * 100)
		const priceCents =
			itemOverride?.price !== null && itemOverride?.price !== undefined
				? Math.round(itemOverride.price * 100)
				: basePriceCents

		const globalItemAvailable =
			isUnavailableUntilExpired(
				item.availabilityStatus,
				item.unavailableUntil,
				now,
			) &&
			(!menuVariations.variants.length || availableVariants.length > 0)
		const locItemAvailable = itemOverride?.availabilityStatus
			? isUnavailableUntilExpired(
					itemOverride.availabilityStatus,
					itemOverride.unavailableUntil,
					now,
				)
			: true

		return [
			{
				id: item.id,
				name: localizedText(item.displayName, 'Item'),
				description: localizedText(item.description),
				category: localizedText(category?.displayName, 'Uncategorized'),
				price: priceCents,
				imageUrl: item.imageUrl ?? null,
				available:
					menuAvailable &&
					categoryAvailable &&
					globalItemAvailable &&
					locItemAvailable,
				modifierGroups: groups,
				variations: remoteVariations,
				menus: [],
				allergens: [...new Set(allergens)].sort(),
				alcohol: item.isAlcohol,
				taxRate: null,
				version: 1,
			},
		]
	})

	return {
		menu: { id: menu.id, name: menuName },
		items: await applyFocalCrops(organizationId, items),
		menus: [],
	}
}

/**
 * Loads multiple menus and combines them for delivery-store sync (#96):
 * merges items by ID while preserving each item's `menus` list of assigned
 * menu names, applies per-location overrides, and omits disabled/hidden
 * records.
 */
export async function loadMenusForSync(
	organizationId: string,
	menuIds: string[],
	options?: LoadMenuForSyncOptions,
): Promise<SyncableMenus> {
	const uniqueMenuIds = [
		...new Set(menuIds.map((id) => id.trim()).filter(Boolean)),
	]
	if (uniqueMenuIds.length === 0) {
		return { selectedMenus: [], items: [], menus: [] }
	}

	const loadedMenus = await Promise.all(
		uniqueMenuIds.map((menuId) =>
			loadMenuForSync(organizationId, menuId, options),
		),
	)

	const selectedMenus: Array<{ id: string; name: string }> = []
	const byItemId = new Map<string, RemoteItem>()
	const remoteMenus: RemoteMenu[] = []

	for (const loaded of loadedMenus) {
		selectedMenus.push(loaded.menu)
		if (loaded.items.length > 0) {
			remoteMenus.push({
				name: loaded.menu.name,
				days: [0, 1, 2, 3, 4, 5, 6],
				start: '00:00',
				end: '23:59',
			})
		}
		for (const item of loaded.items) {
			const existing = byItemId.get(item.id)
			if (existing) {
				if (!existing.menus.includes(loaded.menu.name)) {
					existing.menus.push(loaded.menu.name)
				}
			} else {
				byItemId.set(item.id, {
					...item,
					menus: [loaded.menu.name],
				})
			}
		}
	}

	return {
		selectedMenus,
		items: [...byItemId.values()],
		menus: remoteMenus,
	}
}

/** Preserve complete sellable combinations and their prices in the POS catalog. */
export function projectMenuVariations(
	variations: MenuVariations,
	now = new Date(),
): RemoteItem['variations'] {
	return variations.variants
		.filter((variant) =>
			isUnavailableUntilExpired(
				variant.availabilityStatus,
				variant.unavailableUntil,
				now,
			),
		)
		.map((variant) => ({
			name: variant.valueIds
				.map(
					(id, index) =>
						variations.groups[index]?.values.find((value) => value.id === id)
							?.name ?? '',
				)
				.join(' / '),
			price: Math.round(variant.price * 100),
		}))
}
