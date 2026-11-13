import { createId } from '@paralleldrive/cuid2'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	and,
	db,
	asc,
	eq,
	inArray,
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
	OrganizationMenuOptionNestedModifierGroupAssignment,
} from '@repo/database'
import { checkModifierGraphChange } from './modifier-graph.server.ts'
import {
	assertCategoryIdsInOrganization,
	assertLocationIdsInOrganization,
	assertModifierGroupIdsInOrganization,
} from './ownership.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

function copyName(displayName: string, defaultLocale = 'en') {
	const raw =
		typeof displayName === 'string' && displayName.startsWith('{')
			? getLocalizedMenuValue(displayName, defaultLocale)
			: displayName
	return JSON.stringify({ [defaultLocale]: `${raw} (copy)` })
}

const UNAVAILABLE = 'unavailable' as const

export async function duplicateMenu({
	organizationId,
	organizationSlug,
	menuId,
	copyCategories,
	defaultLocale = 'en',
}: {
	organizationId: string
	organizationSlug: string
	menuId: string
	copyCategories: boolean
	defaultLocale?: string
}) {
	const [menu] = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.id, menuId),
				eq(OrganizationMenu.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!menu) throw new Response('Menu not found', { status: 404 })

	const assignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))

	const newMenuId = createId()
	const categoryMap = new Map<string, string>()

	const createdId = await db.transaction(async (tx) => {
		if (copyCategories) {
			const categoryIds = [...new Set(assignments.map((row) => row.categoryId))]
			if (categoryIds.length > 0) {
				await assertCategoryIdsInOrganization(organizationId, categoryIds, tx)
			}
			const categories = await tx
				.select()
				.from(OrganizationMenuCategory)
				.where(inArray(OrganizationMenuCategory.id, categoryIds))
			for (const category of categories) {
				const newId = createId()
				categoryMap.set(category.id, newId)
				await tx.insert(OrganizationMenuCategory).values({
					...category,
					id: newId,
					displayName: copyName(category.displayName, defaultLocale),
					availabilityStatus: UNAVAILABLE,
					unavailableUntil: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				const itemLinks = await tx
					.select()
					.from(OrganizationMenuItemCategoryAssignment)
					.where(eq(OrganizationMenuItemCategoryAssignment.categoryId, category.id))
				for (const link of itemLinks) {
					await tx.insert(OrganizationMenuItemCategoryAssignment).values({
						...link,
						id: createId(),
						categoryId: newId,
						createdAt: new Date(),
					})
				}
			}
		}

		await tx.insert(OrganizationMenu).values({
			...menu,
			id: newMenuId,
			displayName: copyName(menu.displayName, defaultLocale),
			availabilityStatus: UNAVAILABLE,
			unavailableUntil: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})

		for (const assignment of assignments) {
			const categoryId = copyCategories
				? categoryMap.get(assignment.categoryId)!
				: assignment.categoryId
			await tx.insert(OrganizationMenuCategoryAssignment).values({
				...assignment,
				id: createId(),
				menuId: newMenuId,
				categoryId,
				createdAt: new Date(),
			})
		}

		return newMenuId
	})
	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return { id: createdId }
}

export async function duplicateCategory({
	organizationId,
	organizationSlug,
	categoryId,
	defaultLocale = 'en',
}: {
	organizationId: string
	organizationSlug: string
	categoryId: string
	defaultLocale?: string
}) {
	const [category] = await db
		.select()
		.from(OrganizationMenuCategory)
		.where(
			and(
				eq(OrganizationMenuCategory.id, categoryId),
				eq(OrganizationMenuCategory.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!category) throw new Response('Category not found', { status: 404 })

	const newId = createId()
	await db.transaction(async (tx) => {
		await tx.insert(OrganizationMenuCategory).values({
			...category,
			id: newId,
			displayName: copyName(category.displayName, defaultLocale),
			availabilityStatus: UNAVAILABLE,
			unavailableUntil: null,
			parentId: category.parentId,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		const itemLinks = await tx
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.categoryId, categoryId))
		for (const link of itemLinks) {
			await tx.insert(OrganizationMenuItemCategoryAssignment).values({
				...link,
				id: createId(),
				categoryId: newId,
				createdAt: new Date(),
			})
		}
	})
	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return { id: newId }
}

async function cloneModifierGroupDeep(
	tx: typeof db,
	organizationId: string,
	groupId: string,
	visited: Map<string, string>,
	defaultLocale: string,
) {
	const existing = visited.get(groupId)
	if (existing) return existing

	const [group] = await tx
		.select()
		.from(OrganizationMenuModifierGroup)
		.where(
			and(
				eq(OrganizationMenuModifierGroup.id, groupId),
				eq(OrganizationMenuModifierGroup.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!group) throw new Response('Modifier group not found', { status: 404 })

	const newGroupId = createId()
	visited.set(groupId, newGroupId)

	await tx.insert(OrganizationMenuModifierGroup).values({
		...group,
		id: newGroupId,
		name: copyName(group.name, defaultLocale),
		availabilityStatus: UNAVAILABLE,
		unavailableUntil: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	})

	const optionAssignments = await tx
		.select()
		.from(OrganizationMenuModifierGroupOptionAssignment)
		.where(eq(OrganizationMenuModifierGroupOptionAssignment.modifierGroupId, groupId))

	for (const assignment of optionAssignments) {
		const [option] = await tx
			.select()
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.id, assignment.optionId),
					eq(OrganizationMenuOption.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!option) continue

		let newOptionId = createId()
		const [maybe] = await tx
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, organizationId),
					eq(OrganizationMenuOption.displayName, option.displayName),
					eq(OrganizationMenuOption.internalName, option.internalName ?? null),
				),
			)
			.limit(1)
		if (maybe) newOptionId = maybe.id
		else {
			await tx.insert(OrganizationMenuOption).values({
				...option,
				id: newOptionId,
				displayName: copyName(option.displayName, defaultLocale),
				availabilityStatus: UNAVAILABLE,
				unavailableUntil: null,
				nestedModifierGroupIds: '[]',
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			const nested = await tx
				.select()
				.from(OrganizationMenuOptionNestedModifierGroupAssignment)
				.where(eq(OrganizationMenuOptionNestedModifierGroupAssignment.optionId, option.id))
			const nestedIds: string[] = []
			for (const n of nested) {
				const cloned = await cloneModifierGroupDeep(
					tx,
					organizationId,
					n.modifierGroupId,
					visited,
					defaultLocale,
				)
				nestedIds.push(cloned)
				await tx.insert(OrganizationMenuOptionNestedModifierGroupAssignment).values({
					...n,
					id: createId(),
					optionId: newOptionId,
					modifierGroupId: cloned,
					createdAt: new Date(),
				})
			}
			if (nestedIds.length > 0) {
				const failure = await checkModifierGraphChange(
					organizationId,
					{
						options: [
							{
								id: newOptionId,
								nestedGroupIds: nestedIds,
							},
						],
					},
					tx,
				)
				if (failure) {
					throw Response.json(
						{ error: failure.reason, message: failure.message },
						{ status: 400 },
					)
				}
				await tx
					.update(OrganizationMenuOption)
					.set({ nestedModifierGroupIds: JSON.stringify(nestedIds) })
					.where(eq(OrganizationMenuOption.id, newOptionId))
			}
		}

		await tx.insert(OrganizationMenuModifierGroupOptionAssignment).values({
			...assignment,
			id: createId(),
			modifierGroupId: newGroupId,
			optionId: newOptionId,
			createdAt: new Date(),
		})
	}

	return newGroupId
}

export async function duplicateItem({
	organizationId,
	organizationSlug,
	itemId,
	copyModifierGroups,
	defaultLocale = 'en',
}: {
	organizationId: string
	organizationSlug: string
	itemId: string
	copyModifierGroups: boolean
	defaultLocale?: string
}) {
	const [item] = await db
		.select()
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.id, itemId),
				eq(OrganizationMenuItem.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!item) throw new Response('Item not found', { status: 404 })

	const newItemId = createId()
	const groupLinks = await db
		.select()
		.from(OrganizationMenuItemModifierGroupAssignment)
		.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, itemId))

	await db.transaction(async (tx) => {
		await tx.insert(OrganizationMenuItem).values({
			...item,
			id: newItemId,
			displayName: copyName(item.displayName, defaultLocale),
			availabilityStatus: UNAVAILABLE,
			unavailableUntil: null,
			imageKey: item.imageKey,
			imageUrl: item.imageUrl,
			imageKeys: item.imageKeys,
			createdAt: new Date(),
			updatedAt: new Date(),
		})

		const categoryLinks = await tx
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.itemId, itemId))
		for (const link of categoryLinks) {
			await tx.insert(OrganizationMenuItemCategoryAssignment).values({
				...link,
				id: createId(),
				itemId: newItemId,
				createdAt: new Date(),
			})
		}

		const visited = new Map<string, string>()
		for (const link of groupLinks) {
			const groupId = copyModifierGroups
				? await cloneModifierGroupDeep(
						tx,
						organizationId,
						link.modifierGroupId,
						visited,
						defaultLocale,
					)
				: link.modifierGroupId
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values({
				...link,
				id: createId(),
				itemId: newItemId,
				modifierGroupId: groupId,
				createdAt: new Date(),
			})
		}
	})

	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return { id: newItemId }
}

export async function duplicateModifierGroup({
	organizationId,
	organizationSlug,
	modifierGroupId,
	defaultLocale = 'en',
}: {
	organizationId: string
	organizationSlug: string
	modifierGroupId: string
	defaultLocale?: string
}) {
	await assertModifierGroupIdsInOrganization(organizationId, [modifierGroupId])
	const visited = new Map<string, string>()
	const newId = await db.transaction(async (tx) =>
		cloneModifierGroupDeep(
			tx,
			organizationId,
			modifierGroupId,
			visited,
			defaultLocale,
		),
	)
	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return { id: newId }
}

export class CopyOverridesError extends Error {
	constructor(readonly code: 'source_in_targets' | 'not_found') {
		super(code)
	}
}

export async function copyLocationOverrides({
	organizationId,
	organizationSlug,
	sourceLocationId,
	targetLocationIds,
	replace,
}: {
	organizationId: string
	organizationSlug: string
	sourceLocationId: string
	targetLocationIds: string[]
	replace: boolean
}) {
	if (targetLocationIds.includes(sourceLocationId)) {
		throw new CopyOverridesError('source_in_targets')
	}
	await assertLocationIdsInOrganization(organizationId, [
		sourceLocationId,
		...targetLocationIds,
	])

	const sourceRows = await db
		.select()
		.from(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organizationId),
				eq(OrganizationMenuLocationOverride.locationId, sourceLocationId),
			),
		)
	if (sourceRows.length === 0) throw new CopyOverridesError('not_found')

	await db.transaction(async (tx) => {
		for (const targetLocationId of targetLocationIds) {
			if (replace) {
				await tx
					.delete(OrganizationMenuLocationOverride)
					.where(
						and(
							eq(OrganizationMenuLocationOverride.organizationId, organizationId),
							eq(OrganizationMenuLocationOverride.locationId, targetLocationId),
						),
					)
			}
			for (const row of sourceRows) {
				await tx
					.insert(OrganizationMenuLocationOverride)
					.values({
						...row,
						id: createId(),
						locationId: targetLocationId,
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
							isEnabled: row.isEnabled,
							price: row.price,
							availabilityStatus: row.availabilityStatus,
							unavailableUntil: row.unavailableUntil,
							updatedAt: new Date(),
						},
					})
			}
		}
	})

	await purgeOrganizationSiteCache(organizationId, organizationSlug)
	return { copied: sourceRows.length, targets: targetLocationIds.length }
}
