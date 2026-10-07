import { type DropInput } from '@repo/common/menu-types'
import { pickLocalized } from '@repo/common/site-locales'
import {
	db,
	eq,
	ne,
	and,
	inArray,
	desc,
	asc,
	OrganizationDrop,
	OrganizationDropPickupWindow,
	OrganizationDropInventory,
	OrganizationDropReminder,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationLocation,
} from '@repo/database'
import slugify from '@sindresorhus/slugify'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'

export async function assertDropInOrganization(
	organizationId: string,
	dropId: string,
) {
	const rows = await db
		.select({ id: OrganizationDrop.id, menuId: OrganizationDrop.menuId })
		.from(OrganizationDrop)
		.where(
			and(
				eq(OrganizationDrop.id, dropId),
				eq(OrganizationDrop.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!rows[0]) {
		throw new Response('Drop not found', { status: 404 })
	}
	return rows[0]
}

export async function listDropsForOrganization(organizationId: string) {
	const drops = await db.query.OrganizationDrop.findMany({
		where: eq(OrganizationDrop.organizationId, organizationId),
		orderBy: [desc(OrganizationDrop.createdAt)],
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
			menu: {
				with: {
					categoryAssignments: {
						with: {
							category: {
								with: {
									itemAssignments: {
										with: {
											item: true,
										},
									},
								},
							},
						},
					},
				},
			},
		},
	})

	return drops
}

export async function getDropWithDetails(
	organizationId: string,
	dropId: string,
) {
	const drop = await db.query.OrganizationDrop.findFirst({
		where: and(
			eq(OrganizationDrop.id, dropId),
			eq(OrganizationDrop.organizationId, organizationId),
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
			reminders: {
				orderBy: [asc(OrganizationDropReminder.scheduledAt)],
			},
			menu: {
				with: {
					categoryAssignments: {
						orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
						with: {
							category: {
								with: {
									itemAssignments: {
										orderBy: [
											asc(OrganizationMenuItemCategoryAssignment.position),
										],
										with: {
											item: true,
										},
									},
								},
							},
						},
					},
				},
			},
		},
	})

	return drop
}

export async function saveDrop(
	organizationId: string,
	data: DropInput & {
		assignedCategoryIds?: string[]
		assignedItemIds?: string[]
	},
) {
	let slug =
		slugify(data.slug?.trim() || pickLocalized(data.title, null, 'en'), {
			lowercase: true,
			separator: '-',
		}) || 'drop'

	return await db.transaction(async (tx) => {
		let dropId = data.id
		const menuId = data.menuId

		// Verify that the selected menu belongs to this organization
		const verifiedMenu = await tx
			.select({ id: OrganizationMenu.id })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organizationId),
				),
			)
			.limit(1)

		if (!verifiedMenu[0]) {
			throw new Response('Selected menu not found in organization', {
				status: 400,
			})
		}

		// Ensure unique slug within organization
		const existingWithSlug = await tx
			.select({ id: OrganizationDrop.id })
			.from(OrganizationDrop)
			.where(
				and(
					eq(OrganizationDrop.organizationId, organizationId),
					eq(OrganizationDrop.slug, slug),
					dropId ? ne(OrganizationDrop.id, dropId) : undefined,
				),
			)
			.limit(1)

		if (existingWithSlug.length > 0) {
			slug = `${slug}-${Date.now().toString(36).slice(-4)}`
		}

		if (dropId) {
			const existing = await tx
				.select({ id: OrganizationDrop.id })
				.from(OrganizationDrop)
				.where(
					and(
						eq(OrganizationDrop.id, dropId),
						eq(OrganizationDrop.organizationId, organizationId),
					),
				)
				.limit(1)

			if (!existing[0]) {
				throw new Response('Drop not found', { status: 404 })
			}

			// Update drop record with tenant defense-in-depth
			await tx
				.update(OrganizationDrop)
				.set({
					menuId,
					title: data.title,
					slug,
					description: data.description ?? null,
					coverImageKey: data.coverImageKey ?? null,
					coverImageUrl: data.coverImageUrl ?? null,
					status: data.status,
					ordersOpenAt: data.ordersOpenAt ?? null,
					ordersCloseAt: data.ordersCloseAt ?? null,
					visibility: data.visibility,
					checkoutHoldMinutes: data.checkoutHoldMinutes,
					showOrdersOpenTime: data.showOrdersOpenTime,
					showMenuPreview: data.showMenuPreview,
					showInventoryRemaining: data.showInventoryRemaining,
					includeGiftCard: data.includeGiftCard,
				})
				.where(
					and(
						eq(OrganizationDrop.id, dropId),
						eq(OrganizationDrop.organizationId, organizationId),
					),
				)
		} else {
			// Create drop record referencing existing menu
			const createdDrops = await tx
				.insert(OrganizationDrop)
				.values({
					organizationId,
					menuId,
					title: data.title,
					slug,
					description: data.description ?? null,
					coverImageKey: data.coverImageKey ?? null,
					coverImageUrl: data.coverImageUrl ?? null,
					status: data.status,
					ordersOpenAt: data.ordersOpenAt ?? null,
					ordersCloseAt: data.ordersCloseAt ?? null,
					visibility: data.visibility,
					checkoutHoldMinutes: data.checkoutHoldMinutes,
					showOrdersOpenTime: data.showOrdersOpenTime,
					showMenuPreview: data.showMenuPreview,
					showInventoryRemaining: data.showInventoryRemaining,
					includeGiftCard: data.includeGiftCard,
				})
				.returning({ id: OrganizationDrop.id })

			if (!createdDrops[0]) {
				throw new Error('Failed to create drop')
			}
			dropId = createdDrops[0].id
		}

		// Verify & replace pickup windows (verifying locations belong to this organization)
		await tx
			.delete(OrganizationDropPickupWindow)
			.where(eq(OrganizationDropPickupWindow.dropId, dropId))

		if (data.pickupWindows && data.pickupWindows.length > 0) {
			const verifiedLocations = await tx
				.select({ id: OrganizationLocation.id })
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, organizationId))

			const verifiedLocIds = new Set(verifiedLocations.map((l) => l.id))
			const safeWindows = data.pickupWindows.filter((pw) =>
				verifiedLocIds.has(pw.locationId),
			)

			if (safeWindows.length > 0) {
				await tx.insert(OrganizationDropPickupWindow).values(
					safeWindows.map((pw) => ({
						dropId,
						locationId: pw.locationId,
						date: pw.date,
						startTime: pw.startTime,
						endTime: pw.endTime,
						slotIntervalMinutes: pw.slotIntervalMinutes,
						maxOrdersPerSlot: pw.maxOrdersPerSlot ?? null,
						orderLeadTimeMinutes: pw.orderLeadTimeMinutes,
					})),
				)
			}
		}

		// Keep caps only for categories and items on the selected menu.
		const menuCategories = await tx
			.select({ id: OrganizationMenuCategory.id })
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuCategoryAssignment.categoryId,
				),
			)
			.where(
				and(
					eq(OrganizationMenuCategoryAssignment.menuId, menuId),
					eq(OrganizationMenuCategory.organizationId, organizationId),
				),
			)
		const categoryIds = new Set(menuCategories.map((category) => category.id))
		const menuItems =
			categoryIds.size > 0
				? await tx
						.select({ id: OrganizationMenuItem.id })
						.from(OrganizationMenuItemCategoryAssignment)
						.innerJoin(
							OrganizationMenuItem,
							eq(
								OrganizationMenuItem.id,
								OrganizationMenuItemCategoryAssignment.itemId,
							),
						)
						.where(
							and(
								inArray(OrganizationMenuItemCategoryAssignment.categoryId, [
									...categoryIds,
								]),
								eq(OrganizationMenuItem.organizationId, organizationId),
							),
						)
				: []
		const itemIds = new Set(menuItems.map((item) => item.id))
		const safeOverrides = (data.inventoryOverrides ?? []).filter((override) =>
			override.entityType === 'category'
				? categoryIds.has(override.entityId)
				: itemIds.has(override.entityId),
		)

		await tx
			.delete(OrganizationDropInventory)
			.where(eq(OrganizationDropInventory.dropId, dropId))

		if (safeOverrides.length > 0) {
			await tx.insert(OrganizationDropInventory).values(
				safeOverrides.map((inv) => ({
					dropId,
					entityType: inv.entityType,
					entityId: inv.entityId,
					inventory: inv.inventory ?? null,
					maxPerOrder: inv.maxPerOrder ?? null,
					maxPerPickupSlot: inv.maxPerPickupSlot ?? null,
				})),
			)
		}

		// Replace reminders
		await tx
			.delete(OrganizationDropReminder)
			.where(eq(OrganizationDropReminder.dropId, dropId))

		if (data.reminders && data.reminders.length > 0) {
			await tx.insert(OrganizationDropReminder).values(
				data.reminders.map((rem) => ({
					dropId,
					title: rem.title,
					message: rem.message ?? null,
					triggerType: rem.triggerType,
					scheduledAt: rem.scheduledAt,
					status: rem.status,
				})),
			)
		}

		return dropId
	})
}

export async function deleteDrop(organizationId: string, dropId: string) {
	const drop = await assertDropInOrganization(organizationId, dropId)

	await db.transaction(async (tx) => {
		const [menu] = await tx
			.select({ menuType: OrganizationMenu.menuType })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, drop.menuId),
					eq(OrganizationMenu.organizationId, organizationId),
				),
			)
			.limit(1)

		await tx
			.delete(OrganizationDrop)
			.where(
				and(
					eq(OrganizationDrop.id, dropId),
					eq(OrganizationDrop.organizationId, organizationId),
				),
			)

		// Older drops owned a private menu. Shared menus must survive deletion,
		// because OrganizationDrop.menuId cascades and would erase the menu's drops.
		if (menu?.menuType !== 'drop') return

		const [otherDrop] = await tx
			.select({ id: OrganizationDrop.id })
			.from(OrganizationDrop)
			.where(eq(OrganizationDrop.menuId, drop.menuId))
			.limit(1)
		if (otherDrop) return

		await tx
			.delete(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, drop.menuId),
					eq(OrganizationMenu.organizationId, organizationId),
					eq(OrganizationMenu.menuType, 'drop'),
				),
			)

		await deleteMenuEntityReferences(organizationId, 'menu', drop.menuId, tx)
	})
}
