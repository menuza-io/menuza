import {
	applyModifierGraphChange,
	MAX_NESTED_MODIFIER_DEPTH,
	type ModifierGraph,
	type ModifierGraphChange,
	type ModifierGraphErrorReason,
	validateModifierGraph,
} from '@repo/common/menu-types'
import {
	db,
	eq,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'

type MenuReadClient = Pick<typeof db, 'select'>

export interface OrganizationModifierGraph extends ModifierGraph {
	groupNames: Record<string, string>
}

function parseIds(value: string | null): string[] {
	if (!value) return []
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === 'string')
			: []
	} catch {
		return []
	}
}

/**
 * The organization's nested modifier graph as guests walk it: group options
 * from the assignment table and nested groups from the option's
 * `nestedModifierGroupIds` (the column the public readers use). Pass the
 * transaction client so the check sees what the write will change.
 */
export async function loadModifierGraph(
	organizationId: string,
	client: MenuReadClient = db,
): Promise<OrganizationModifierGraph> {
	const groups = await client
		.select({
			id: OrganizationMenuModifierGroup.id,
			name: OrganizationMenuModifierGroup.name,
		})
		.from(OrganizationMenuModifierGroup)
		.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
	const assignments = await client
		.select({
			groupId: OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
			optionId: OrganizationMenuModifierGroupOptionAssignment.optionId,
		})
		.from(OrganizationMenuModifierGroupOptionAssignment)
		.innerJoin(
			OrganizationMenuModifierGroup,
			eq(
				OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				OrganizationMenuModifierGroup.id,
			),
		)
		.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
	const options = await client
		.select({
			id: OrganizationMenuOption.id,
			nested: OrganizationMenuOption.nestedModifierGroupIds,
		})
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, organizationId))

	const groupOptions: Record<string, string[]> = {}
	const groupNames: Record<string, string> = {}
	for (const group of groups) {
		groupOptions[group.id] = []
		groupNames[group.id] = group.name
	}
	for (const { groupId, optionId } of assignments) {
		groupOptions[groupId]?.push(optionId)
	}
	const optionNestedGroups: Record<string, string[]> = {}
	for (const option of options) {
		const nested = parseIds(option.nested)
		if (nested.length > 0) optionNestedGroups[option.id] = nested
	}
	return { groupOptions, optionNestedGroups, groupNames }
}

/** The graph after a save, with names for groups the save creates or renames. */
function applyChange(
	graph: OrganizationModifierGraph,
	change: ModifierGraphChange & {
		groups?: Array<{ id: string; name?: string; optionIds: string[] }>
	},
): OrganizationModifierGraph {
	const groupNames = { ...graph.groupNames }
	for (const group of change.groups ?? []) {
		if (group.name !== undefined) groupNames[group.id] = group.name
	}
	return { ...applyModifierGraphChange(graph, change), groupNames }
}

export interface ModifierGraphFailure {
	reason: ModifierGraphErrorReason
	/** Group names along the offending chain. */
	path: string[]
	message: string
}

export function describeModifierGraphFailure(
	reason: ModifierGraphErrorReason,
	path: string[],
): string {
	const chain = path.join(' → ')
	return reason === 'modifier_cycle'
		? `These nested groups would loop: ${chain}.`
		: `Nested groups can go at most ${MAX_NESTED_MODIFIER_DEPTH} levels below a dish's group: ${chain}.`
}

/**
 * Loads the organization graph with `client`, applies the proposed change and
 * validates it. Returns null when the save may go ahead. Only loops and
 * over-deep chains the change introduces are refused, so older bad data stays
 * readable and editable.
 */
export async function checkModifierGraphChange(
	organizationId: string,
	change: ModifierGraphChange & {
		groups?: Array<{ id: string; name?: string; optionIds: string[] }>
	},
	client: MenuReadClient = db,
): Promise<ModifierGraphFailure | null> {
	const before = await loadModifierGraph(organizationId, client)
	const after = applyChange(before, change)
	const result = validateModifierGraph({
		groupOptions: after.groupOptions,
		optionNestedGroups: after.optionNestedGroups,
		previous: before,
	})
	if (result.ok) return null
	const path = result.path.map((id) => after.groupNames[id] ?? id)
	return {
		reason: result.reason,
		path,
		message: describeModifierGraphFailure(result.reason, path),
	}
}

/** The 400 every nested-group save returns; nothing has been written. */
export function modifierGraphErrorResponse(failure: ModifierGraphFailure) {
	return Response.json(
		{
			error: { nestedModifierGroupIds: [failure.message] },
			modifierGraph: { reason: failure.reason, path: failure.path },
		},
		{ status: 400 },
	)
}
