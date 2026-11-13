import { createId } from '@paralleldrive/cuid2'
import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuOption,
} from '@repo/database'
import { checkModifierGraphChange } from './modifier-graph.server.ts'
import {
	planBulkEditItem,
	planBulkEditOption,
	type BulkItemOperation,
	type BulkOptionOperation,
} from './bulk-edit.ts'
import { createMenuSnapshot } from './snapshot.server.ts'
import { assertCategoryIdsInOrganization, assertItemIdsInOrganization, assertModifierGroupIdsInOrganization, assertOptionIdsInOrganization } from './ownership.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export function currencyExponentFor(currency: string) {
	const zero = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF'])
	return zero.has(currency.toUpperCase()) ? 0 : 2
}

export function currencyCodeForDataRegion(dataRegion: string | null | undefined) {
	return dataRegion === 'ksa' ? 'SAR' : 'USD'
}

export async function applyBulkItemEdit({
	organizationId,
	organizationSlug,
	userId,
	request,
	itemIds,
	operation,
	locationId,
	expectedUpdatedAt,
}: {
	organizationId: string
	organizationSlug: string
	userId: string
	request?: Request
	itemIds: string[]
	operation: BulkItemOperation
	locationId?: string | null
	expectedUpdatedAt: Record<string, string>
}) {
	await assertItemIdsInOrganization(organizationId, itemIds)
	if (operation.type === 'add_category' || operation.type === 'remove_category') {
		await assertCategoryIdsInOrganization(organizationId, [operation.categoryId])
	}
	if (operation.type === 'add_modifier_group' || operation.type === 'remove_modifier_group') {
		await assertModifierGroupIdsInOrganization(organizationId, [
			operation.modifierGroupId,
		])
	}

	const items = await db
		.select()
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, organizationId),
				inArray(OrganizationMenuItem.id, itemIds),
			),
		)
	const stale = items.filter((row) => {
		const sent = expectedUpdatedAt[row.id]
		if (!sent) return true
		return new Date(sent).getTime() !== row.updatedAt.getTime()
	})
	if (stale.length > 0) {
		return Response.json(
			{
				error: 'stale_rows',
				staleIds: stale.map((row) => row.id),
			},
			{ status: 409 },
		)
	}

	const categoryLinks = await db
		.select()
		.from(OrganizationMenuItemCategoryAssignment)
		.where(inArray(OrganizationMenuItemCategoryAssignment.itemId, itemIds))
	const categoryByItem = new Map<string, string[]>()
	for (const link of categoryLinks) {
		const list = categoryByItem.get(link.itemId) ?? []
		list.push(link.categoryId)
		categoryByItem.set(link.itemId, list)
	}

	const groupLinks = await db
		.select()
		.from(OrganizationMenuItemModifierGroupAssignment)
		.where(inArray(OrganizationMenuItemModifierGroupAssignment.itemId, itemIds))
	const groupByItem = new Map<string, string[]>()
	for (const link of groupLinks) {
		const list = groupByItem.get(link.itemId) ?? []
		list.push(link.modifierGroupId)
		groupByItem.set(link.itemId, list)
	}

	const org = await db.query.Organization.findFirst({
		where: (fields, { eq: equals }) => equals(fields.id, organizationId),
		columns: { dataRegion: true },
	})
	const exponent = currencyExponentFor(currencyCodeForDataRegion(org?.dataRegion))

	const rowInputs = items.map((row) => ({
		id: row.id,
		updatedAt: row.updatedAt,
		displayName: row.displayName,
		price: row.price,
		availabilityStatus: row.availabilityStatus as 'available',
		unavailableUntil: row.unavailableUntil,
		applySalesTax: row.applySalesTax,
		isVegetarian: row.isVegetarian,
		isGlutenFree: row.isGlutenFree,
		isAlcohol: row.isAlcohol,
		isPopular: row.isPopular,
		isUpsell: row.isUpsell,
		categoryIds: categoryByItem.get(row.id) ?? [],
		modifierGroupIds: groupByItem.get(row.id) ?? [],
	}))

	const plans = planBulkEditItem({
		rows: rowInputs,
		operation,
		currencyExponent: exponent,
	})

	if (operation.type === 'add_modifier_group') {
		for (const plan of plans) {
			if (plan.skipped) continue
			const added = plan.after.modifierGroupIds.find(
				(id) => !plan.before.modifierGroupIds.includes(id),
			)
			if (!added) continue
			const failure = await checkModifierGraphChange(organizationId, {
				groups: [{ id: added, optionIds: [] }],
			})
			if (failure) {
				plan.skipped = failure.reason
				plan.after = plan.before
			}
		}
	}

	const snapshotId = await createMenuSnapshot({
		organizationId,
		reason: 'before_bulk_edit',
		userId,
	})

	let applied = 0
	await db.transaction(async (tx) => {
		for (const plan of plans) {
			if (plan.skipped) continue
			const after = plan.after
			if (locationId && (operation.type === 'price' || operation.type === 'availability')) {
				if (operation.type === 'price') {
					await tx
						.insert(OrganizationMenuLocationOverride)
						.values({
							id: createId(),
							organizationId,
							locationId,
							entityType: 'item',
							entityId: after.id,
							price: after.price,
							createdAt: new Date(),
							updatedAt: new Date(),
						})
						.onConflictDoUpdate({
							target: [
								OrganizationMenuLocationOverride.locationId,
								OrganizationMenuLocationOverride.entityType,
								OrganizationMenuLocationOverride.entityId,
							],
							set: { price: after.price, updatedAt: new Date() },
						})
				} else {
					await tx
						.insert(OrganizationMenuLocationOverride)
						.values({
							id: createId(),
							organizationId,
							locationId,
							entityType: 'item',
							entityId: after.id,
							availabilityStatus: after.availabilityStatus,
							unavailableUntil: after.unavailableUntil,
							createdAt: new Date(),
							updatedAt: new Date(),
						})
						.onConflictDoUpdate({
							target: [
								OrganizationMenuLocationOverride.locationId,
								OrganizationMenuLocationOverride.entityType,
								OrganizationMenuLocationOverride.entityId,
							],
							set: {
								availabilityStatus: after.availabilityStatus,
								unavailableUntil: after.unavailableUntil,
								updatedAt: new Date(),
							},
						})
				}
				applied++
				continue
			}

			await tx
				.update(OrganizationMenuItem)
				.set({
					price: after.price,
					availabilityStatus: after.availabilityStatus,
					unavailableUntil: after.unavailableUntil,
					applySalesTax: after.applySalesTax,
					isVegetarian: after.isVegetarian,
					isGlutenFree: after.isGlutenFree,
					isAlcohol: after.isAlcohol,
					isPopular: after.isPopular,
					isUpsell: after.isUpsell,
					updatedAt: new Date(),
				})
				.where(eq(OrganizationMenuItem.id, after.id))

			if (operation.type === 'add_category') {
				await tx.insert(OrganizationMenuItemCategoryAssignment).values({
					id: createId(),
					categoryId: operation.categoryId,
					itemId: after.id,
					position: 0,
					createdAt: new Date(),
				})
			}
			if (operation.type === 'remove_category') {
				await tx
					.delete(OrganizationMenuItemCategoryAssignment)
					.where(
						and(
							eq(OrganizationMenuItemCategoryAssignment.itemId, after.id),
							eq(OrganizationMenuItemCategoryAssignment.categoryId, operation.categoryId),
						),
					)
			}
			if (operation.type === 'add_modifier_group') {
				await tx.insert(OrganizationMenuItemModifierGroupAssignment).values({
					id: createId(),
					itemId: after.id,
					modifierGroupId: operation.modifierGroupId,
					position: 0,
					createdAt: new Date(),
				})
			}
			if (operation.type === 'remove_modifier_group') {
				await tx
					.delete(OrganizationMenuItemModifierGroupAssignment)
					.where(
						and(
							eq(OrganizationMenuItemModifierGroupAssignment.itemId, after.id),
							eq(
								OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
								operation.modifierGroupId,
							),
						),
					)
			}
			applied++
		}
	})

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId,
		resourceType: 'menu_bulk_edit',
		resourceId: snapshotId,
		details: `Bulk updated ${applied} menu items`,
		metadata: { itemIds, operation: operation.type, undoSnapshotId: snapshotId },
		request,
	})
	await purgeOrganizationSiteCache(organizationId, organizationSlug)

	return Response.json({
		ok: true,
		applied,
		snapshotId,
		plans,
	})
}

export async function applyBulkOptionEdit({
	organizationId,
	organizationSlug,
	userId,
	request,
	optionIds,
	operation,
	locationId,
	expectedUpdatedAt,
}: {
	organizationId: string
	organizationSlug: string
	userId: string
	request?: Request
	optionIds: string[]
	operation: BulkOptionOperation
	locationId?: string | null
	expectedUpdatedAt: Record<string, string>
}) {
	await assertOptionIdsInOrganization(organizationId, optionIds)
	const options = await db
		.select()
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.organizationId, organizationId),
				inArray(OrganizationMenuOption.id, optionIds),
			),
		)
	const stale = options.filter((row) => {
		const sent = expectedUpdatedAt[row.id]
		if (!sent) return true
		return new Date(sent).getTime() !== row.updatedAt.getTime()
	})
	if (stale.length > 0) {
		return Response.json(
			{ error: 'stale_rows', staleIds: stale.map((row) => row.id) },
			{ status: 409 },
		)
	}

	const org = await db.query.Organization.findFirst({
		where: (fields, { eq: equals }) => equals(fields.id, organizationId),
		columns: { dataRegion: true },
	})
	const exponent = currencyExponentFor(currencyCodeForDataRegion(org?.dataRegion))
	const rows = options.map((row) => ({
		id: row.id,
		updatedAt: row.updatedAt,
		displayName: row.displayName,
		price: row.price,
		availabilityStatus: row.availabilityStatus as 'available',
		unavailableUntil: row.unavailableUntil,
		isVegetarian: row.isVegetarian,
		isGlutenFree: row.isGlutenFree,
		isAlcohol: row.isAlcohol,
	}))

	const plans = planBulkEditOption({
		rows,
		operation,
		currencyExponent: exponent,
	})

	const snapshotId = await createMenuSnapshot({
		organizationId,
		reason: 'before_bulk_edit',
		userId,
	})

	let applied = 0
	await db.transaction(async (tx) => {
		for (const plan of plans) {
			if (plan.skipped) continue
			const after = plan.after
			if (locationId && (operation.type === 'price' || operation.type === 'availability')) {
				await tx
					.insert(OrganizationMenuLocationOverride)
					.values({
						id: createId(),
						organizationId,
						locationId,
						entityType: 'modifier_option',
						entityId: after.id,
						price: operation.type === 'price' ? after.price : undefined,
						availabilityStatus:
							operation.type === 'availability'
								? after.availabilityStatus
								: undefined,
						unavailableUntil:
							operation.type === 'availability' ? after.unavailableUntil : undefined,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: [
							OrganizationMenuLocationOverride.locationId,
							OrganizationMenuLocationOverride.entityType,
							OrganizationMenuLocationOverride.entityId,
						],
						set: {
							price: operation.type === 'price' ? after.price : undefined,
							availabilityStatus:
								operation.type === 'availability'
									? after.availabilityStatus
									: undefined,
							unavailableUntil:
								operation.type === 'availability' ? after.unavailableUntil : undefined,
							updatedAt: new Date(),
						},
					})
			} else {
				await tx
					.update(OrganizationMenuOption)
					.set({
						price: after.price,
						availabilityStatus: after.availabilityStatus,
						unavailableUntil: after.unavailableUntil,
						isVegetarian: after.isVegetarian,
						isGlutenFree: after.isGlutenFree,
						isAlcohol: after.isAlcohol,
						updatedAt: new Date(),
					})
					.where(eq(OrganizationMenuOption.id, after.id))
			}
			applied++
		}
	})

	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId,
		organizationId,
		resourceType: 'menu_bulk_edit',
		resourceId: snapshotId,
		details: `Bulk updated ${applied} menu options`,
		metadata: { optionIds, operation: operation.type, undoSnapshotId: snapshotId },
		request,
	})

	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return Response.json({ ok: true, applied, snapshotId, plans })
}
