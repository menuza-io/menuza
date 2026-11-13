import { type ModifierGroupInput } from '@repo/common/menu-types'
import {
	and,
	db,
	eq,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import {
	checkModifierGraphChange,
	type ModifierGraphFailure,
} from './modifier-graph.server.ts'
import {
	assertItemIdsInOrganization,
	assertLocationIdsInOrganization,
	assertModifierGroupIdsInOrganization,
} from './ownership.server.ts'

export type CreateModifierGroupResult =
	| {
			ok: true
			/** False when `id` already named a group of this organization (a retry). */
			created: boolean
			group: { id: string; name: string; selectionType: string }
	  }
	| { ok: false; failure: ModifierGraphFailure }

/**
 * Creates a modifier group with its options (new reusable options, or links
 * to existing ones), dish assignments and location overrides, in one
 * transaction. Shared by the full Menu, Modifiers form and the quick create
 * sheet on the dish and option forms.
 *
 * With `id` (a client-generated id) the create is idempotent: a retry returns
 * the group the first request made instead of a second one. Nested groups
 * that would loop or nest too deep are refused before anything is written.
 */
export async function createModifierGroup(
	organizationId: string,
	data: ModifierGroupInput,
	{ id }: { id?: string } = {},
): Promise<CreateModifierGroupResult> {
	const { options, assignedItemIds, selectionType, availabilityStatus, name } =
		data
	const internalName = data.internalName || null
	const minSelections =
		selectionType === 'single'
			? Math.min(Math.max(data.minSelections, 0), 1)
			: data.minSelections
	const maxSelections =
		selectionType === 'single' ? 1 : (data.maxSelections ?? null)
	const unavailableUntil =
		(availabilityStatus === 'unavailable_until' ||
			availabilityStatus === 'unavailable_until_tomorrow') &&
		data.unavailableUntil
			? data.unavailableUntil
			: null
	const overrideEntries = Object.values(data.locationOverrides ?? {})

	// Options without an id are created by this save; give the check a stand-in.
	const graphOptionIds = options.map((opt, i) => opt.id || `new-option:${i}`)
	return db.transaction(async (tx): Promise<CreateModifierGroupResult> => {
		if (id) {
			// A retry of the same create: hand back the group it made.
			const [existing] = await tx
				.select({
					id: OrganizationMenuModifierGroup.id,
					organizationId: OrganizationMenuModifierGroup.organizationId,
					name: OrganizationMenuModifierGroup.name,
					selectionType: OrganizationMenuModifierGroup.selectionType,
				})
				.from(OrganizationMenuModifierGroup)
				.where(eq(OrganizationMenuModifierGroup.id, id))
				.limit(1)
			if (existing) {
				if (existing.organizationId !== organizationId) {
					throw new Response('Modifier group id already used', {
						status: 409,
					})
				}
				return {
					ok: true,
					created: false,
					group: {
						id: existing.id,
						name: existing.name,
						selectionType: existing.selectionType,
					},
				}
			}
		}
		await assertItemIdsInOrganization(organizationId, assignedItemIds, tx)
		await assertLocationIdsInOrganization(
			organizationId,
			overrideEntries
				.map((entry) => entry.locationId)
				.filter((id): id is string => typeof id === 'string'),
			tx,
		)
		await assertModifierGroupIdsInOrganization(
			organizationId,
			[...new Set(options.flatMap((opt) => opt.nestedModifierGroupIds ?? []))],
			tx,
		)
		// Refuse loops and over-deep nesting before anything is written.
		const failure = await checkModifierGraphChange(
			organizationId,
			{
				groups: [{ id: id ?? 'new-group', name, optionIds: graphOptionIds }],
				options: options.map((opt, i) => ({
					id: graphOptionIds[i]!,
					nestedGroupIds: opt.nestedModifierGroupIds ?? [],
				})),
			},
			tx,
		)
		if (failure) return { ok: false, failure }

		// Create Group
		const [newGroup] = await tx
			.insert(OrganizationMenuModifierGroup)
			.values({
				...(id ? { id } : {}),
				organizationId,
				name,
				internalName,
				selectionType,
				minSelections,
				maxSelections,
				availabilityStatus,
				unavailableUntil,
			})
			.returning()

		if (!newGroup) {
			throw new Error('Failed to create modifier group')
		}

		// Create or link reusable menu options, then assign them to this group.
		// OrganizationMenuOption is the single source of truth used by both the
		// Options page and modifier groups.
		if (options.length > 0) {
			const isPizzaGroup = selectionType === 'pizza'

			for (const [i, opt] of options.entries()) {
				const optionPrice = opt.price || 0
				const priceWhole = isPizzaGroup ? optionPrice : (opt.priceWhole ?? null)
				const priceLeft = isPizzaGroup ? (opt.priceLeft ?? null) : null
				const priceRight = isPizzaGroup ? (opt.priceRight ?? null) : null
				let targetOptionId = opt.id
				if (targetOptionId) {
					const [existing] = await tx
						.select({ id: OrganizationMenuOption.id })
						.from(OrganizationMenuOption)
						.where(
							and(
								eq(OrganizationMenuOption.id, targetOptionId),
								eq(OrganizationMenuOption.organizationId, organizationId),
							),
						)
						.limit(1)
					if (!existing) targetOptionId = undefined
				}
				const nestedIds = opt.nestedModifierGroupIds ?? []
				if (!targetOptionId) {
					const [created] = await tx
						.insert(OrganizationMenuOption)
						.values({
							organizationId,
							displayName: opt.displayName,
							internalName: opt.internalName || null,
							price: optionPrice,
							priceWhole,
							priceLeft,
							priceRight,
							isGlutenFree: opt.isGlutenFree ?? false,
							isVegetarian: opt.isVegetarian ?? false,
							isAlcohol: opt.isAlcohol ?? false,
							isTopping: isPizzaGroup || (opt.isTopping ?? false),
							nestedModifierGroupIds: JSON.stringify(nestedIds),
							position: i,
						})
						.returning()
					targetOptionId = created?.id
				} else {
					await tx
						.update(OrganizationMenuOption)
						.set({
							displayName: opt.displayName,
							internalName: opt.internalName || null,
							price: optionPrice,
							priceWhole,
							priceLeft,
							priceRight,
							isGlutenFree: opt.isGlutenFree ?? false,
							isVegetarian: opt.isVegetarian ?? false,
							isAlcohol: opt.isAlcohol ?? false,
							isTopping: isPizzaGroup || (opt.isTopping ?? false),
							nestedModifierGroupIds: JSON.stringify(nestedIds),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(OrganizationMenuOption.id, targetOptionId),
								eq(OrganizationMenuOption.organizationId, organizationId),
							),
						)
				}
				if (targetOptionId) {
					await tx
						.insert(OrganizationMenuModifierGroupOptionAssignment)
						.values({
							modifierGroupId: newGroup.id,
							optionId: targetOptionId,
							isDefault: opt.isDefault ?? false,
							position: i,
						})
				}
			}
		}

		// Insert Item Assignments
		if (assignedItemIds.length > 0) {
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values(
				assignedItemIds.map((itemId, index) => ({
					itemId,
					modifierGroupId: newGroup.id,
					position: index,
				})),
			)
		}

		// Insert Location Overrides
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId,
					locationId: entry.locationId,
					entityType: 'modifier_group',
					entityId: newGroup.id,
					isEnabled: entry.isEnabled,
					price: entry.price,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
		return {
			ok: true,
			created: true,
			group: {
				id: newGroup.id,
				name: newGroup.name,
				selectionType: newGroup.selectionType,
			},
		}
	})
}
