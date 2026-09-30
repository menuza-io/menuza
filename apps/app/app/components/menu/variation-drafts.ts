import {
	reconcileMenuVariations,
	type MenuVariations,
} from '@repo/common/menu-types'

export type DraftVariationGroup = MenuVariations['groups'][number]
export type VariationHistory = Map<string, MenuVariations['variants'][number]>

const combinationKey = (
	groups: MenuVariations['groups'],
	variant: MenuVariations['variants'][number],
) =>
	`${groups.map((group) => group.id).join('\u001e')}|${variant.valueIds.join('\u001f')}`

export function reconcileDraftVariations(
	current: MenuVariations,
	drafts: DraftVariationGroup[],
	defaultPrice: number,
	history: VariationHistory,
	createId: () => string = () => crypto.randomUUID(),
): MenuVariations {
	for (const variant of current.variants)
		history.set(combinationKey(current.groups, variant), variant)
	const groups = activeVariationGroups(drafts)
	const next = reconcileMenuVariations(current, groups, defaultPrice, createId)
	const usedIds = new Set<string>()
	return {
		...next,
		variants: next.variants.map((variant) => {
			const saved = history.get(combinationKey(groups, variant))
			const restored = saved
				? { ...saved, valueIds: variant.valueIds }
				: variant
			const unique = usedIds.has(restored.id)
				? { ...restored, id: createId() }
				: restored
			usedIds.add(unique.id)
			return unique
		}),
	}
}

function blankValueId(group: DraftVariationGroup) {
	let index = group.values.length
	let id = `__draft__${group.id}__${index}`
	while (group.values.some((value) => value.id === id)) {
		index += 1
		id = `__draft__${group.id}__${index}`
	}
	return id
}

export function withTrailingBlank(
	group: DraftVariationGroup,
): DraftVariationGroup {
	if (group.values.at(-1)?.name.trim() === '') return group
	return {
		...group,
		values: [...group.values, { id: blankValueId(group), name: '' }],
	}
}

export function toDraftVariationGroups(
	groups: MenuVariations['groups'],
): DraftVariationGroup[] {
	return groups.map(withTrailingBlank)
}

export function activeVariationGroups(
	groups: DraftVariationGroup[],
): MenuVariations['groups'] {
	return groups.flatMap((group) => {
		const values = group.values.filter((value) => value.name.trim() !== '')
		return values.length ? [{ ...group, values }] : []
	})
}

export function updateDraftVariationValue(
	groups: DraftVariationGroup[],
	groupId: string,
	valueId: string,
	name: string,
): DraftVariationGroup[] {
	return groups.map((group) =>
		group.id === groupId
			? withTrailingBlank({
					...group,
					values: group.values.map((value) =>
						value.id === valueId ? { ...value, name } : value,
					),
				})
			: group,
	)
}

export function discardEmptyDraftValue(
	groups: DraftVariationGroup[],
	groupId: string,
	valueId: string,
): DraftVariationGroup[] {
	const target = groups.find((group) => group.id === groupId)
	const value = target?.values.find((entry) => entry.id === valueId)
	if (
		!target ||
		!value ||
		value.name.trim() ||
		(target.values.at(-1)?.id === valueId && value.name === '')
	)
		return groups
	return groups.map((group) => {
		if (group.id !== groupId) return group
		const index = group.values.findIndex((value) => value.id === valueId)
		if (index < 0 || group.values[index]?.name.trim()) return group
		if (index === group.values.length - 1)
			return {
				...group,
				values: group.values.map((value) =>
					value.id === valueId ? { ...value, name: '' } : value,
				),
			}
		return {
			...group,
			values: group.values.filter((value) => value.id !== valueId),
		}
	})
}

export function canAddVariationValue(
	groups: DraftVariationGroup[],
	groupId: string,
): boolean {
	const counts = groups.map(
		(group) =>
			group.values.filter((value) => value.name.trim()).length +
			(group.id === groupId ? 1 : 0),
	)
	return (
		counts.filter(Boolean).reduce((total, count) => total * count, 1) <= 100
	)
}
