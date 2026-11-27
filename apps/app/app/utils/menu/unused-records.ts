/**
 * Unused menu records (#235). A record used by a category, a dish, a group,
 * a drop or a location override is in use. POS-linked records are listed and
 * cannot be deleted from tidy-up.
 */

import { neutralizeCsvCell, toCsv } from '@repo/common/csv'

export type UsageEntityType =
	'item' | 'modifier_group' | 'modifier_option' | 'category'

export type UsageRef = { entityType: string; entityId: string }

export type MenuUsageGraph = {
	itemIds: readonly string[]
	groupIds: readonly string[]
	optionIds: readonly string[]
	categoryItemIds: ReadonlySet<string>
	itemGroupIds: ReadonlyMap<string, readonly string[]>
	groupItemIds: ReadonlyMap<string, readonly string[]>
	groupOptionIds: ReadonlyMap<string, readonly string[]>
	optionGroupIds: ReadonlyMap<string, readonly string[]>
	nestedGroupIds: ReadonlySet<string>
	dropIds: ReadonlySet<string>
	overrideIds: ReadonlySet<string>
	posLinkedIds: ReadonlySet<string>
}

export function itemNotInAnyCategory(
	graph: MenuUsageGraph,
	itemId: string,
): boolean {
	return !graph.categoryItemIds.has(itemId)
}

export function itemHasNoOptionGroups(
	graph: MenuUsageGraph,
	itemId: string,
): boolean {
	return (graph.itemGroupIds.get(itemId) ?? []).length === 0
}

export function groupNotUsedByAnyDish(
	graph: MenuUsageGraph,
	groupId: string,
): boolean {
	return (graph.groupItemIds.get(groupId) ?? []).length === 0
}

export function optionNotInAnyGroup(
	graph: MenuUsageGraph,
	optionId: string,
): boolean {
	return (graph.optionGroupIds.get(optionId) ?? []).length === 0
}

function anchored(graph: MenuUsageGraph, id: string): boolean {
	return graph.dropIds.has(id) || graph.overrideIds.has(id)
}

/** True when nothing in the menu, a drop or a location override uses it. */
export function isUnusedRecord(
	graph: MenuUsageGraph,
	entityType: 'item' | 'modifier_group' | 'modifier_option',
	id: string,
): boolean {
	if (anchored(graph, id)) return false
	if (entityType === 'item') return itemNotInAnyCategory(graph, id)
	if (entityType === 'modifier_group') {
		return groupNotUsedByAnyDish(graph, id) && !graph.nestedGroupIds.has(id)
	}
	return optionNotInAnyGroup(graph, id)
}

export type TidyRecord = {
	entityType: 'item' | 'modifier_group' | 'modifier_option'
	id: string
	name: string
	updatedAt: string
	posLinked: boolean
	deletable: boolean
}

export function tidyRecords(
	graph: MenuUsageGraph,
	rows: readonly Omit<TidyRecord, 'posLinked' | 'deletable'>[],
): TidyRecord[] {
	return rows
		.filter((row) => isUnusedRecord(graph, row.entityType, row.id))
		.map((row) => {
			const posLinked = graph.posLinkedIds.has(row.id)
			return { ...row, posLinked, deletable: !posLinked }
		})
}

export type ExclusiveCleanup = {
	groupIds: string[]
	optionIds: string[]
}

/**
 * Groups and options that nothing else uses once `removedItemIds` are gone.
 * A group still on another dish, nested under a remaining option, anchored
 * by a drop or override, or linked to a POS stays. An option stays when any
 * remaining group still contains it.
 */
export function exclusiveModifierCleanup(
	graph: MenuUsageGraph,
	removedItemIds: readonly string[],
): ExclusiveCleanup {
	const removed = new Set(removedItemIds)
	const groupIds: string[] = []
	for (const groupId of graph.groupIds) {
		if (graph.posLinkedIds.has(groupId)) continue
		if (anchored(graph, groupId)) continue
		if (graph.nestedGroupIds.has(groupId)) continue
		const users = graph.groupItemIds.get(groupId) ?? []
		if (users.length === 0) continue
		if (users.every((itemId) => removed.has(itemId))) groupIds.push(groupId)
	}
	const removingGroups = new Set(groupIds)
	const optionIds: string[] = []
	for (const optionId of graph.optionIds) {
		if (graph.posLinkedIds.has(optionId)) continue
		if (anchored(graph, optionId)) continue
		const groups = graph.optionGroupIds.get(optionId) ?? []
		if (groups.length === 0) continue
		if (groups.every((groupId) => removingGroups.has(groupId))) {
			optionIds.push(optionId)
		}
	}
	return { groupIds, optionIds }
}

const CSV_HEADERS = ['type', 'name', 'last changed', 'pos linked', 'can delete']

export function unusedRecordsCsv(rows: readonly TidyRecord[]): string {
	return toCsv(
		CSV_HEADERS.map((header) => neutralizeCsvCell(header)),
		rows.map((row) => [
			row.entityType,
			neutralizeCsvCell(row.name),
			row.updatedAt,
			row.posLinked ? 'yes' : 'no',
			row.deletable ? 'yes' : 'no',
		]),
	)
}
