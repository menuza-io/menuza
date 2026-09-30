/**
 * Persists canonical modifier groups/options from a POS catalog import into
 * Menuza menu tables.
 */

import {
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPosLink as PosLink,
	and,
	count,
	db,
	eq,
} from '@repo/database'
import { slug } from './wire.ts'
import { type RemoteItem } from './types.ts'

type PersistModifiersParams = {
	organizationId: string
	integrationId: string
	providerName: string
	item: RemoteItem
	localItemId: string
}

export async function persistImportedItemModifiers(
	params: PersistModifiersParams,
): Promise<void> {
	const { organizationId, integrationId, providerName, item, localItemId } =
		params
	if (!item.modifierGroups.length) return

	for (
		let groupPosition = 0;
		groupPosition < item.modifierGroups.length;
		groupPosition++
	) {
		const group = item.modifierGroups[groupPosition]!
		const remoteGroupId = group.id ?? `${item.id}:group:${slug(group.name)}`
		const modifierGroupId = await ensureModifierGroup({
			organizationId,
			integrationId,
			providerName,
			remoteGroupId,
			group,
		})

		await db
			.insert(OrganizationMenuItemModifierGroupAssignment)
			.values({
				itemId: localItemId,
				modifierGroupId,
				position: groupPosition,
			})
			.onConflictDoNothing()

		for (
			let optionPosition = 0;
			optionPosition < group.options.length;
			optionPosition++
		) {
			const option = group.options[optionPosition]!
			const remoteOptionId =
				option.id ?? `${remoteGroupId}:option:${slug(option.name)}`
			const optionId = await ensureModifierOption({
				organizationId,
				integrationId,
				providerName,
				remoteOptionId,
				option,
			})
			await db
				.insert(OrganizationMenuModifierGroupOptionAssignment)
				.values({
					modifierGroupId,
					optionId,
					position: optionPosition,
				})
				.onConflictDoNothing()
		}
	}
}

async function ensureModifierGroup(params: {
	organizationId: string
	integrationId: string
	providerName: string
	remoteGroupId: string
	group: RemoteItem['modifierGroups'][number]
}): Promise<string> {
	const linked = await findPosLink(
		params.integrationId,
		'modifier_group',
		params.remoteGroupId,
	)
	if (linked) return linked

	const maxSelections = params.group.max > 0 ? params.group.max : null
	const [created] = await db
		.insert(OrganizationMenuModifierGroup)
		.values({
			organizationId: params.organizationId,
			name: params.group.name,
			internalName: slug(params.group.name),
			selectionType: params.group.max === 1 ? 'single' : 'multiple',
			minSelections: Math.max(0, params.group.min),
			maxSelections,
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
	})
	return created.id
}

async function ensureModifierOption(params: {
	organizationId: string
	integrationId: string
	providerName: string
	remoteOptionId: string
	option: RemoteItem['modifierGroups'][number]['options'][number]
}): Promise<string> {
	const linked = await findPosLink(
		params.integrationId,
		'modifier_option',
		params.remoteOptionId,
	)
	if (linked) return linked

	const [created] = await db
		.insert(OrganizationMenuOption)
		.values({
			organizationId: params.organizationId,
			displayName: params.option.name,
			internalName: slug(params.option.name),
			price: params.option.price / 100,
			availabilityStatus:
				params.option.available === false ? 'unavailable' : 'available',
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
	})
	return created.id
}

async function findPosLink(
	integrationId: string,
	entityType: string,
	remoteId: string,
): Promise<string | null> {
	const row = await db
		.select({ localId: PosLink.localId })
		.from(PosLink)
		.where(
			and(
				eq(PosLink.integrationId, integrationId),
				eq(PosLink.entityType, entityType),
				eq(PosLink.remoteId, remoteId),
			),
		)
		.limit(1)
		.then((rows) => rows[0])
	return row?.localId ?? null
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
