/**
 * Fresh public drop payload builder.
 *
 * Extracted from `resources+/sites.drop.ts` so internal consumers
 * (`resources+/order-context.ts`, used by the regional tenant service to
 * revalidate drop restaurant orders) can read the authoritative drop catalog
 * directly from the control-plane database, bypassing the published-site KV
 * cache.
 *
 * Contains no customer PII: only public drop, pickup window, inventory cap,
 * and menu data. Callers are responsible for refusing to serve draft drops to
 * anyone other than authenticated org members previewing.
 */

import { type LocationAddress } from '@repo/common/location-types'
import { generatePickupSlots, type PickupSlot } from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	OrganizationMediaAsset,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationDrop,
	OrganizationDropPickupWindow,
} from '@repo/database'
import {
	applyOptionAssignment,
	attachNestedModifierGroups,
	safeJsonParse,
	serializePublicMenuItem,
	serializePublicModifierGroup,
	serializePublicOption,
	type MenuModifierGroupRow,
	type MenuOptionAssignmentRow,
	type MenuOptionRow,
	type PublicMenuItemData,
	type PublicModifierGroupData,
} from './public-serializers.server.ts'

type LoadedModifierGroup = MenuModifierGroupRow & {
	optionAssignments: Array<MenuOptionAssignmentRow & { option: MenuOptionRow }>
}

// Nested groups reference each other by id, so a bounded walk is enough.
const MAX_NESTED_GROUP_DEPTH = 3

/** Org fields the drop builder needs; no PII. */
export interface PublicSiteDropOrgContext {
	id: string
	name: string
	slug: string
	/** Org-level fallback currency ('USD' | 'SAR'). */
	currency: string
}

export interface PublicSiteDropPayload {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
	}
	drop: {
		id: string
		title: string
		slug: string
		description: string | null
		coverImageKey: string | null
		coverImageUrl: string | null
		status: string
		ordersOpenAt: string | null
		ordersCloseAt: string | null
		visibility: string
		checkoutHoldMinutes: number
		showOrdersOpenTime: boolean
		showMenuPreview: boolean
		showInventoryRemaining: boolean
		includeGiftCard: boolean
		menu: {
			id: string
			displayName: string
			specialInstructions: boolean
		}
	}
	pickupWindows: Array<{
		id: string
		locationId: string | null
		location: {
			id: string
			name: string
			phone: string | null
			address: LocationAddress | null
			timezone: string | null
		} | null
		date: string
		startTime: string
		endTime: string
		slotIntervalMinutes: number | null
		maxOrdersPerSlot: number | null
		orderLeadTimeMinutes: number | null
		slots: PickupSlot[]
	}>
	inventoryOverrides: Array<{
		id: string
		dropId: string
		entityType: string
		entityId: string
		inventory: number | null
		maxPerOrder: number | null
		maxPerPickupSlot: number | null
	}>
	categories: Array<{
		id: string
		displayName: string
		internalName: string | null
		description: string | null
		items: PublicMenuItemData[]
	}>
}

/**
 * Build the public drop payload (drop details, pickup windows with generated
 * slots, inventory caps, and the drop's priced categories) from the live
 * control-plane database. Never reads or writes the site KV cache.
 *
 * Returns null when the org has no drop with this slug. The payload may still
 * describe a draft drop; callers must apply their own publication rules
 * (never serve drafts to the public, and never leak them to other services).
 */
export async function buildPublicSiteDropPayload(
	org: PublicSiteDropOrgContext,
	dropSlug: string,
): Promise<PublicSiteDropPayload | null> {
	// 1. Resolve Drop
	const drop = await db.query.OrganizationDrop.findFirst({
		where: and(
			eq(OrganizationDrop.organizationId, org.id),
			eq(OrganizationDrop.slug, dropSlug),
		),
		with: {
			pickupWindows: {
				with: {
					location: true,
				},
				orderBy: [
					asc(OrganizationDropPickupWindow.date),
					asc(OrganizationDropPickupWindow.startTime),
				],
			},
			inventoryOverrides: true,
		},
	})

	if (!drop) {
		return null
	}

	// 2. Resolve Media Asset URLs
	const mediaAssets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			updatedAt: OrganizationMediaAsset.updatedAt,
		})
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.organizationId, org.id))

	const mediaMap = new Map<string, string>()
	for (const m of mediaAssets) {
		const mediaUrl = `/resources/images?mediaId=${encodeURIComponent(m.id)}&v=${m.updatedAt.getTime()}`
		mediaMap.set(m.id, mediaUrl)
		mediaMap.set(m.objectKey, mediaUrl)
	}

	// 3. Fetch Drop Menu Categories & Items
	const categoryAssignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.menuId, drop.menuId))
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))

	const categoryIds = categoryAssignments.map((ca) => ca.categoryId)

	const categories = categoryIds.length
		? await db.query.OrganizationMenuCategory.findMany({
				where: and(
					eq(OrganizationMenuCategory.organizationId, org.id),
					inArray(OrganizationMenuCategory.id, categoryIds),
				),
				orderBy: [asc(OrganizationMenuCategory.position)],
			})
		: []

	const dropCategories = categories.filter((c) => categoryIds.includes(c.id))

	// Fetch items in these categories (scoped strictly to drop category IDs!)
	const relevantItemAssignments = categoryIds.length
		? await db
				.select()
				.from(OrganizationMenuItemCategoryAssignment)
				.where(
					inArray(
						OrganizationMenuItemCategoryAssignment.categoryId,
						categoryIds,
					),
				)
				.orderBy(asc(OrganizationMenuItemCategoryAssignment.position))
		: []

	const itemIds = relevantItemAssignments.map((ia) => ia.itemId)

	const items = itemIds.length
		? await db.query.OrganizationMenuItem.findMany({
				where: and(
					eq(OrganizationMenuItem.organizationId, org.id),
					inArray(OrganizationMenuItem.id, itemIds),
				),
				orderBy: [asc(OrganizationMenuItem.position)],
				with: {
					modifierGroupAssignments: {
						orderBy: [
							asc(OrganizationMenuItemModifierGroupAssignment.position),
						],
						with: {
							modifierGroup: {
								with: {
									optionAssignments: {
										orderBy: [
											asc(
												OrganizationMenuModifierGroupOptionAssignment.position,
											),
										],
										with: {
											option: true,
										},
									},
								},
							},
						},
					},
				},
			})
		: []

	const now = new Date()

	// 4. Serialize modifier groups, following nested group references
	const groupsMap = new Map<string, PublicModifierGroupData>()
	const serializeGroup = (group: LoadedModifierGroup) => {
		const options = group.optionAssignments.map((oa) =>
			applyOptionAssignment(
				serializePublicOption(oa.option, mediaMap, now),
				oa,
			),
		)
		groupsMap.set(group.id, serializePublicModifierGroup(group, options, now))
	}
	for (const item of items) {
		for (const mga of item.modifierGroupAssignments) {
			if (!groupsMap.has(mga.modifierGroup.id))
				serializeGroup(mga.modifierGroup)
		}
	}
	for (let depth = 0; depth < MAX_NESTED_GROUP_DEPTH; depth++) {
		const missingIds = new Set<string>()
		for (const group of groupsMap.values()) {
			for (const option of group.options) {
				for (const nestedId of option.nestedModifierGroupIds ?? []) {
					if (!groupsMap.has(nestedId)) missingIds.add(nestedId)
				}
			}
		}
		if (missingIds.size === 0) break
		const nestedGroups = await db.query.OrganizationMenuModifierGroup.findMany({
			where: and(
				eq(OrganizationMenuModifierGroup.organizationId, org.id),
				inArray(OrganizationMenuModifierGroup.id, Array.from(missingIds)),
			),
			with: {
				optionAssignments: {
					orderBy: [
						asc(OrganizationMenuModifierGroupOptionAssignment.position),
					],
					with: { option: true },
				},
			},
		})
		if (nestedGroups.length === 0) break
		for (const group of nestedGroups) serializeGroup(group)
	}
	attachNestedModifierGroups(groupsMap.values(), groupsMap)

	const itemsMap = new Map(
		items.map((item) => [
			item.id,
			serializePublicMenuItem(
				item,
				item.modifierGroupAssignments.flatMap((mga) => {
					const group = groupsMap.get(mga.modifierGroup.id)
					return group ? [group] : []
				}),
				mediaMap,
				now,
			),
		]),
	)

	// Map categories with items
	const formattedCategories = dropCategories.map((cat) => ({
		id: cat.id,
		displayName: cat.displayName,
		internalName: cat.internalName,
		description: cat.description,
		availabilityStatus: cat.availabilityStatus ?? 'available',
		items: relevantItemAssignments
			.filter((ia) => ia.categoryId === cat.id)
			.flatMap((ia) => {
				const item = itemsMap.get(ia.itemId)
				return item ? [item] : []
			}),
	}))

	const menu = await db.query.OrganizationMenu.findFirst({
		where: eq(OrganizationMenu.id, drop.menuId),
		columns: { id: true, displayName: true, specialInstructions: true },
	})

	// Format pickup windows with generated slots
	const formattedWindows = drop.pickupWindows.map((pw) => {
		const slots = generatePickupSlots(
			pw.startTime,
			pw.endTime,
			pw.slotIntervalMinutes,
		)
		return {
			id: pw.id,
			locationId: pw.locationId,
			location: pw.location
				? {
						id: pw.location.id,
						name: pw.location.name,
						phone: pw.location.phone,
						address: safeJsonParse<LocationAddress | null>(
							pw.location.address,
							null,
						),
						timezone: pw.location.timezone,
					}
				: null,
			date: pw.date,
			startTime: pw.startTime,
			endTime: pw.endTime,
			slotIntervalMinutes: pw.slotIntervalMinutes,
			maxOrdersPerSlot: pw.maxOrdersPerSlot,
			orderLeadTimeMinutes: pw.orderLeadTimeMinutes,
			slots,
		}
	})

	return {
		organization: {
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency: org.currency,
		},
		drop: {
			id: drop.id,
			title: drop.title,
			slug: drop.slug,
			description: drop.description,
			coverImageKey: drop.coverImageKey,
			coverImageUrl: drop.coverImageKey
				? (mediaMap.get(drop.coverImageKey) ?? drop.coverImageUrl)
				: drop.coverImageUrl,
			status: drop.status,
			ordersOpenAt: drop.ordersOpenAt ? drop.ordersOpenAt.toISOString() : null,
			ordersCloseAt: drop.ordersCloseAt
				? drop.ordersCloseAt.toISOString()
				: null,
			visibility: drop.visibility,
			checkoutHoldMinutes: drop.checkoutHoldMinutes,
			showOrdersOpenTime: drop.showOrdersOpenTime,
			showMenuPreview: drop.showMenuPreview,
			showInventoryRemaining: drop.showInventoryRemaining,
			includeGiftCard: drop.includeGiftCard,
			menu: {
				id: drop.menuId,
				displayName: menu?.displayName ?? '',
				specialInstructions: menu ? Boolean(menu.specialInstructions) : true,
			},
		},
		pickupWindows: formattedWindows,
		inventoryOverrides: drop.inventoryOverrides,
		categories: formattedCategories,
	}
}
