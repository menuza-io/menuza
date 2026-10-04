import slugify from '@sindresorhus/slugify'
import { type DropInput } from '@repo/common/menu-types'
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
	OrganizationMenuItemCategoryAssignment,
	OrganizationLocation,
} from '@repo/database'

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
		slugify(data.slug?.trim() || data.title, {
			lowercase: true,
			separator: '-',
		}) || 'drop'

	return await db.transaction(async (tx) => {
		let dropId = data.id
		let menuId: string

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
				.select({ id: OrganizationDrop.id, menuId: OrganizationDrop.menuId })
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

			menuId = existing[0].menuId

			// Update hidden drop menu with tenant defense-in-depth
			await tx
				.update(OrganizationMenu)
				.set({
					displayName: data.title,
					internalName: `[Drop] ${data.title}`,
					menuType: 'drop',
					availabilityStatus:
						data.status === 'live' ? 'available' : 'unavailable',
				})
				.where(
					and(
						eq(OrganizationMenu.id, menuId),
						eq(OrganizationMenu.organizationId, organizationId),
					),
				)

			// Update drop record with tenant defense-in-depth
			await tx
				.update(OrganizationDrop)
				.set({
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
			// Create hidden drop menu first
			const createdMenus = await tx
				.insert(OrganizationMenu)
				.values({
					organizationId,
					displayName: data.title,
					internalName: `[Drop] ${data.title}`,
					menuType: 'drop',
					availabilityStatus:
						data.status === 'live' ? 'available' : 'unavailable',
				})
				.returning({ id: OrganizationMenu.id })

			if (!createdMenus[0]) {
				throw new Error('Failed to create drop menu')
			}
			menuId = createdMenus[0].id

			// Create drop record
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

		// Verify & reassign categories belonging to this organization
		if (data.assignedCategoryIds) {
			await tx
				.delete(OrganizationMenuCategoryAssignment)
				.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))

			if (data.assignedCategoryIds.length > 0) {
				const verifiedCategories = await tx
					.select({ id: OrganizationMenuCategory.id })
					.from(OrganizationMenuCategory)
					.where(
						and(
							eq(OrganizationMenuCategory.organizationId, organizationId),
							inArray(OrganizationMenuCategory.id, data.assignedCategoryIds),
						),
					)

				const verifiedCatIds = new Set(verifiedCategories.map((c) => c.id))
				const safeCategoryIds = data.assignedCategoryIds.filter((id) =>
					verifiedCatIds.has(id),
				)

				if (safeCategoryIds.length > 0) {
					await tx.insert(OrganizationMenuCategoryAssignment).values(
						safeCategoryIds.map((categoryId, position) => ({
							menuId,
							categoryId,
							position,
						})),
					)
				}
			}
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

		// Verify & replace inventory overrides
		await tx
			.delete(OrganizationDropInventory)
			.where(eq(OrganizationDropInventory.dropId, dropId))

		if (data.inventoryOverrides && data.inventoryOverrides.length > 0) {
			await tx.insert(OrganizationDropInventory).values(
				data.inventoryOverrides.map((inv) => ({
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
		await tx
			.delete(OrganizationDrop)
			.where(
				and(
					eq(OrganizationDrop.id, dropId),
					eq(OrganizationDrop.organizationId, organizationId),
				),
			)
		await tx
			.delete(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, drop.menuId),
					eq(OrganizationMenu.organizationId, organizationId),
				),
			)
	})
}
