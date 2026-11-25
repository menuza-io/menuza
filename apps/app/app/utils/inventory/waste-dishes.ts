import { parseMenuVariations } from '@repo/common/menu-types'
import { type MenuGraph, sourceText } from '#app/utils/menu/menu-graph.ts'

/**
 * Dishes for the Log waste picker (#517): the menu's dishes with their sizes
 * and the options a guest can add. The region knows dishes, sizes and options
 * by id only; the App joins the names from the menu it owns.
 */
export type WasteDish = {
	id: string
	name: string
	/** Sizes (variations), each named by its values: "Large", "Large · Spicy". */
	variants: Array<{ id: string; label: string }>
	/** Option groups of the dish (extra cheese, sauces), with their options. */
	groups: Array<{
		id: string
		name: string
		options: Array<{ id: string; name: string }>
	}>
}

/** Most dishes sent to the browser. */
export const WASTE_DISHES_CAP = 500

export function buildWasteDishes(graph: MenuGraph): WasteDish[] {
	const optionName = new Map(
		graph.options.map((option) => [
			option.id,
			sourceText(graph, option.displayName),
		]),
	)
	const groupOptions = new Map<string, string[]>()
	for (const link of [...graph.groupOptions].sort(
		(a, b) => a.position - b.position,
	)) {
		const list = groupOptions.get(link.modifierGroupId)
		if (list) list.push(link.optionId)
		else groupOptions.set(link.modifierGroupId, [link.optionId])
	}
	const groups = new Map(graph.groups.map((group) => [group.id, group]))
	const itemGroups = new Map<string, string[]>()
	for (const link of [...graph.itemGroups].sort(
		(a, b) => a.position - b.position,
	)) {
		const list = itemGroups.get(link.itemId)
		if (list) list.push(link.modifierGroupId)
		else itemGroups.set(link.itemId, [link.modifierGroupId])
	}
	return [...graph.items]
		.sort((a, b) => a.position - b.position)
		.slice(0, WASTE_DISHES_CAP)
		.map((item) => {
			const variations = parseMenuVariations(item.variations)
			return {
				id: item.id,
				name: sourceText(graph, item.displayName),
				variants: variations.variants.map((variant) => ({
					id: variant.id,
					label: variant.valueIds
						.map(
							(valueId, index) =>
								variations.groups[index]?.values.find(
									(value) => value.id === valueId,
								)?.name ?? '',
						)
						.filter(Boolean)
						.join(' · '),
				})),
				groups: (itemGroups.get(item.id) ?? []).flatMap((groupId) => {
					const group = groups.get(groupId)
					if (!group) return []
					return [
						{
							id: group.id,
							name: group.name,
							options: (groupOptions.get(group.id) ?? []).map((id) => ({
								id,
								name: optionName.get(id) ?? '',
							})),
						},
					]
				}),
			}
		})
		.filter((dish) => dish.name !== '')
}
