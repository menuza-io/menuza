/**
 * Persists canonical modifier groups/options from a POS catalog import into
 * Menuza menu tables, respecting per-field POS ownership and overrides (#93).
 */

import {
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPosLink as PosLink,
	and,
	asc,
	count,
	db,
	eq,
} from '@repo/database'
import {
	extractModifierGroupPosValues,
	extractModifierOptionPosValues,
	parseOverriddenFields,
	type PosFieldOwnership,
} from './ownership.ts'
import { localizedText } from './project.ts'
import { type RemoteItem } from './types.ts'
import { slug } from './wire.ts'

type PersistModifiersParams = {
	organizationId: string
	integrationId: string
	providerName: string
	item: RemoteItem
	localItemId: string
	ownership?: PosFieldOwnership
	syncExisting?: boolean
}

function updateStoredText(
	existing: string | null | undefined,
	nextPlain: string,
): string {
	if (existing && existing.startsWith('{')) {
		try {
			const parsed = JSON.parse(existing) as Record<string, string>
			parsed.en = nextPlain
			return JSON.stringify(parsed)
		} catch {
			return nextPlain
		}
	}
	return nextPlain
}

export async function persistImportedItemModifiers(
	params: PersistModifiersParams,
): Promise<boolean> {
	const {
		organizationId,
		integrationId,
		providerName,
		item,
		localItemId,
		ownership,
		syncExisting = false,
	} = params

	if (!syncExisting && !item.modifierGroups.length) return false

	let changed = false
	const targetGroupIds: string[] = []

	for (
		let groupPosition = 0;
		groupPosition < item.modifierGroups.length;
		groupPosition++
	) {
		const group = item.modifierGroups[groupPosition]!
		const remoteGroupId = group.id ?? `${item.id}:group:${slug(group.name)}`
		const groupResult = await ensureModifierGroup({
			organizationId,
			integrationId,
			providerName,
			remoteGroupId,
			group,
			ownership,
			syncExisting,
		})
		if (groupResult.changed) changed = true
		const modifierGroupId = groupResult.id
		targetGroupIds.push(modifierGroupId)

		if (!syncExisting) {
			await db
				.insert(OrganizationMenuItemModifierGroupAssignment)
				.values({
					itemId: localItemId,
					modifierGroupId,
					position: groupPosition,
				})
				.onConflictDoNothing()
		}

		const targetOptionIds: string[] = []
		for (
			let optionPosition = 0;
			optionPosition < group.options.length;
			optionPosition++
		) {
			const option = group.options[optionPosition]!
			const remoteOptionId =
				option.id ?? `${remoteGroupId}:option:${slug(option.name)}`
			const optionResult = await ensureModifierOption({
				organizationId,
				integrationId,
				providerName,
				remoteOptionId,
				option,
				ownership,
				syncExisting,
			})
			if (optionResult.changed) changed = true
			targetOptionIds.push(optionResult.id)

			if (!syncExisting) {
				await db
					.insert(OrganizationMenuModifierGroupOptionAssignment)
					.values({
						modifierGroupId,
						optionId: optionResult.id,
						position: optionPosition,
					})
					.onConflictDoNothing()
			}
		}

		if (syncExisting && (!ownership || ownership.modifiers === 'pos')) {
			const currentGroupOpts = await db
				.select({
					optionId: OrganizationMenuModifierGroupOptionAssignment.optionId,
				})
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.where(
					eq(
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
						modifierGroupId,
					),
				)
				.orderBy(asc(OrganizationMenuModifierGroupOptionAssignment.position))
			const currentOptIds = currentGroupOpts.map((r) => r.optionId)
			if (JSON.stringify(currentOptIds) !== JSON.stringify(targetOptionIds)) {
				changed = true
				await db
					.delete(OrganizationMenuModifierGroupOptionAssignment)
					.where(
						eq(
							OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
							modifierGroupId,
						),
					)
				if (targetOptionIds.length > 0) {
					await db.insert(OrganizationMenuModifierGroupOptionAssignment).values(
						targetOptionIds.map((optionId, position) => ({
							modifierGroupId,
							optionId,
							position,
						})),
					)
				}
			}
		}
	}

	if (syncExisting && (!ownership || ownership.modifiers === 'pos')) {
		const currentAssignments = await db
			.select({
				modifierGroupId:
					OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
			})
			.from(OrganizationMenuItemModifierGroupAssignment)
			.where(
				eq(OrganizationMenuItemModifierGroupAssignment.itemId, localItemId),
			)
			.orderBy(asc(OrganizationMenuItemModifierGroupAssignment.position))
		const currentIds = currentAssignments.map((r) => r.modifierGroupId)
		if (JSON.stringify(currentIds) !== JSON.stringify(targetGroupIds)) {
			changed = true
			await db
				.delete(OrganizationMenuItemModifierGroupAssignment)
				.where(
					eq(OrganizationMenuItemModifierGroupAssignment.itemId, localItemId),
				)
			if (targetGroupIds.length > 0) {
				await db.insert(OrganizationMenuItemModifierGroupAssignment).values(
					targetGroupIds.map((modifierGroupId, position) => ({
						itemId: localItemId,
						modifierGroupId,
						position,
					})),
				)
			}
		}
	}

	return changed
}

async function ensureModifierGroup(params: {
	organizationId: string
	integrationId: string
	providerName: string
	remoteGroupId: string
	group: RemoteItem['modifierGroups'][number]
	ownership?: PosFieldOwnership
	syncExisting?: boolean
}): Promise<{ id: string; changed: boolean }> {
	const now = new Date()
	const posValues = JSON.stringify(extractModifierGroupPosValues(params.group))
	const linked = await findPosLinkRow(
		params.integrationId,
		'modifier_group',
		params.remoteGroupId,
	)

	const nextSelectionType = params.group.max === 1 ? 'single' : 'multiple'
	const nextMin = Math.max(0, params.group.min)
	const nextMax = params.group.max > 0 ? params.group.max : null

	if (linked) {
		await db
			.update(PosLink)
			.set({ posValues, lastSyncedAt: now, updatedAt: now })
			.where(eq(PosLink.id, linked.id))

		if (!params.syncExisting) {
			return { id: linked.localId, changed: false }
		}

		const [existing] = await db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.id, linked.localId))
			.limit(1)
		if (!existing) return { id: linked.localId, changed: false }

		const overridden = new Set(parseOverriddenFields(linked.overriddenFields))
		const updates: Partial<typeof OrganizationMenuModifierGroup.$inferInsert> =
			{}
		let changed = false

		if (
			(!params.ownership || params.ownership.name === 'pos') &&
			!overridden.has('name') &&
			localizedText(existing.name) !== params.group.name
		) {
			updates.name = updateStoredText(existing.name, params.group.name)
			changed = true
		}

		if (!params.ownership || params.ownership.modifiers === 'pos') {
			if (existing.selectionType !== nextSelectionType) {
				updates.selectionType = nextSelectionType
				changed = true
			}
			if (existing.minSelections !== nextMin) {
				updates.minSelections = nextMin
				changed = true
			}
			if ((existing.maxSelections ?? null) !== nextMax) {
				updates.maxSelections = nextMax
				changed = true
			}
		}

		if (changed) {
			await db
				.update(OrganizationMenuModifierGroup)
				.set({ ...updates, updatedAt: now })
				.where(eq(OrganizationMenuModifierGroup.id, existing.id))
		}
		return { id: existing.id, changed }
	}

	const [created] = await db
		.insert(OrganizationMenuModifierGroup)
		.values({
			organizationId: params.organizationId,
			name: params.group.name,
			internalName: slug(params.group.name),
			selectionType: nextSelectionType,
			minSelections: nextMin,
			maxSelections: nextMax,
			availabilityStatus: 'available',
			position: 0,
		})
		.returning()
	if (!created) throw new Error('Failed to create modifier group.')
	await db.insert(PosLink).values({
		organizationId: params.organizationId,
		integrationId: params.integrationId,
		providerName: params.providerName,
		entityType: 'modifier_group',
		remoteId: params.remoteGroupId,
		localId: created.id,
		lastSyncedAt: now,
		posValues,
		overriddenFields: '[]',
	})
	return { id: created.id, changed: true }
}

async function ensureModifierOption(params: {
	organizationId: string
	integrationId: string
	providerName: string
	remoteOptionId: string
	option: RemoteItem['modifierGroups'][number]['options'][number]
	ownership?: PosFieldOwnership
	syncExisting?: boolean
}): Promise<{ id: string; changed: boolean }> {
	const now = new Date()
	const posValues = JSON.stringify(
		extractModifierOptionPosValues(params.option),
	)
	const linked = await findPosLinkRow(
		params.integrationId,
		'modifier_option',
		params.remoteOptionId,
	)

	const nextPrice = params.option.price / 100
	const nextStatus =
		params.option.available === false ? 'unavailable' : 'available'

	if (linked) {
		await db
			.update(PosLink)
			.set({ posValues, lastSyncedAt: now, updatedAt: now })
			.where(eq(PosLink.id, linked.id))

		if (!params.syncExisting) {
			return { id: linked.localId, changed: false }
		}

		const [existing] = await db
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.id, linked.localId))
			.limit(1)
		if (!existing) return { id: linked.localId, changed: false }

		const overridden = new Set(parseOverriddenFields(linked.overriddenFields))
		const updates: Partial<typeof OrganizationMenuOption.$inferInsert> = {}
		let changed = false

		if (
			(!params.ownership || params.ownership.name === 'pos') &&
			!overridden.has('name') &&
			localizedText(existing.displayName) !== params.option.name
		) {
			updates.displayName = updateStoredText(
				existing.displayName,
				params.option.name,
			)
			changed = true
		}

		if (
			(!params.ownership || params.ownership.price === 'pos') &&
			!overridden.has('price') &&
			Math.abs(existing.price - nextPrice) > 1e-6
		) {
			updates.price = nextPrice
			if (existing.isTopping) {
				updates.priceWhole = nextPrice
			}
			changed = true
		}

		if (
			(!params.ownership || params.ownership.available === 'pos') &&
			!overridden.has('available') &&
			existing.availabilityStatus !== nextStatus
		) {
			updates.availabilityStatus = nextStatus
			updates.unavailableUntil = null
			changed = true
		}

		if (changed) {
			await db
				.update(OrganizationMenuOption)
				.set({ ...updates, updatedAt: now })
				.where(eq(OrganizationMenuOption.id, existing.id))
		}
		return { id: existing.id, changed }
	}

	const [created] = await db
		.insert(OrganizationMenuOption)
		.values({
			organizationId: params.organizationId,
			displayName: params.option.name,
			internalName: slug(params.option.name),
			price: nextPrice,
			availabilityStatus: nextStatus,
			minSelections: 0,
			maxSelections: 1,
		})
		.returning()
	if (!created) throw new Error('Failed to create modifier option.')
	await db.insert(PosLink).values({
		organizationId: params.organizationId,
		integrationId: params.integrationId,
		providerName: params.providerName,
		entityType: 'modifier_option',
		remoteId: params.remoteOptionId,
		localId: created.id,
		lastSyncedAt: now,
		posValues,
		overriddenFields: '[]',
	})
	return { id: created.id, changed: true }
}

async function findPosLinkRow(
	integrationId: string,
	entityType: string,
	remoteId: string,
) {
	return db
		.select()
		.from(PosLink)
		.where(
			and(
				eq(PosLink.integrationId, integrationId),
				eq(PosLink.entityType, entityType),
				eq(PosLink.remoteId, remoteId),
			),
		)
		.limit(1)
		.then((rows) => rows[0] ?? null)
}

export async function localItemHasModifierGroups(
	localItemId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ value: count() })
		.from(OrganizationMenuItemModifierGroupAssignment)
		.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, localItemId))
	return (row?.value ?? 0) > 0
}
