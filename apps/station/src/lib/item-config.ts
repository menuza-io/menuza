import { t } from '@lingui/macro'
import { isAvailable } from './availability.ts'
import { toCents } from './money.ts'
import { type CartLine, type CartOption } from './pricing.ts'
import { type MenuItem, type MenuOption, type ModifierGroup } from './types.ts'

/** groupId -> optionId -> quantity (1 for single/multiple groups). */
export type Selections = Record<string, Record<string, number>>
/** variation groupId -> chosen value id. */
export type VariantPicks = Record<string, string>

export const availableOptions = (group: ModifierGroup): MenuOption[] =>
	group.options
		.filter((o) => isAvailable(o.availabilityStatus))
		.sort((a, b) => a.position - b.position)

/** The group's own options plus any nested groups that selected options reveal. */
export function visibleGroups(
	item: MenuItem,
	selections: Selections,
): ModifierGroup[] {
	const out: ModifierGroup[] = []
	const seen = new Set<string>()
	const walk = (group: ModifierGroup) => {
		if (seen.has(group.id) || !isAvailable(group.availabilityStatus)) return
		seen.add(group.id)
		out.push(group)
		for (const option of group.options) {
			if ((selections[group.id]?.[option.id] ?? 0) > 0) {
				option.nestedModifierGroups?.forEach(walk)
			}
		}
	}
	;[...item.modifierGroups]
		.sort((a, b) => a.position - b.position)
		.forEach(walk)
	return out
}

export function defaultSelections(item: MenuItem): Selections {
	const selections: Selections = {}
	const walk = (group: ModifierGroup) => {
		for (const option of availableOptions(group)) {
			if (option.isDefault) {
				;(selections[group.id] ??= {})[option.id] = 1
				option.nestedModifierGroups?.forEach(walk)
			}
		}
	}
	item.modifierGroups.forEach(walk)
	return selections
}

export function defaultVariantPicks(item: MenuItem): VariantPicks {
	const picks: VariantPicks = {}
	for (const group of item.variations.groups) {
		const first = group.values.find((value) =>
			item.variations.variants.some(
				(v) =>
					v.valueIds.includes(value.id) && isAvailable(v.availabilityStatus),
			),
		)
		if (first) picks[group.id] = first.id
	}
	return picks
}

export function resolveVariant(item: MenuItem, picks: VariantPicks) {
	const groups = item.variations.groups
	if (groups.length === 0) return null
	const chosen = groups.map((g) => picks[g.id])
	if (chosen.some((c) => !c)) return null
	return (
		item.variations.variants.find(
			(v) =>
				v.valueIds.length === chosen.length &&
				chosen.every((id) => v.valueIds.includes(id as string)),
		) ?? null
	)
}

export function toggleOption(
	group: ModifierGroup,
	option: MenuOption,
	selections: Selections,
): Selections {
	const current = { ...selections[group.id] }
	const on = (current[option.id] ?? 0) > 0
	if (group.selectionType === 'single') {
		return {
			...selections,
			[group.id]: on && group.minSelections === 0 ? {} : { [option.id]: 1 },
		}
	}
	if (on) delete current[option.id]
	else {
		const max = group.maxSelections
		if (max !== null && Object.keys(current).length >= max) return selections
		current[option.id] = 1
	}
	return { ...selections, [group.id]: current }
}

export function stepOption(
	group: ModifierGroup,
	option: MenuOption,
	delta: number,
	selections: Selections,
): Selections {
	const current = { ...selections[group.id] }
	const next = Math.max(0, (current[option.id] ?? 0) + delta)
	const total =
		Object.values(current).reduce((s, q) => s + q, 0) -
		(current[option.id] ?? 0) +
		next
	if (group.maxSelections !== null && total > group.maxSelections)
		return selections
	if (next === 0) delete current[option.id]
	else current[option.id] = Math.min(next, 50)
	return { ...selections, [group.id]: current }
}

/** Human message for the first unmet rule, or null when the item can be added. */
export function validateConfig(
	item: MenuItem,
	picks: VariantPicks,
	selections: Selections,
): string | null {
	if (item.variations.groups.length > 0) {
		const variant = resolveVariant(item, picks)
		if (!variant) {
			const missing = item.variations.groups.find((g) => !picks[g.id])?.name
			return missing ? t`Choose ${missing}` : t`Choose a size`
		}
		if (!isAvailable(variant.availabilityStatus))
			return t`That choice is sold out`
	}
	for (const group of visibleGroups(item, selections)) {
		const count = Object.values(selections[group.id] ?? {}).reduce(
			(s, q) => s + q,
			0,
		)
		const name = group.name
		const min = group.minSelections
		const max = group.maxSelections
		if (count < min)
			return min <= 1 ? t`Choose ${name}` : t`${name}: choose at least ${min}`
		if (max !== null && count > max) return t`${name}: choose at most ${max}`
	}
	return null
}

export function buildLine(
	item: MenuItem,
	picks: VariantPicks,
	selections: Selections,
	quantity: number,
	instructions: string,
): Omit<CartLine, 'id'> {
	const variant = resolveVariant(item, picks)
	const variantLabel = variant
		? item.variations.groups
				.map((g) => g.values.find((v) => v.id === picks[g.id])?.name)
				.filter(Boolean)
				.join(' · ')
		: null
	const options: CartOption[] = []
	for (const group of visibleGroups(item, selections)) {
		for (const option of group.options) {
			const qty = selections[group.id]?.[option.id] ?? 0
			if (qty <= 0) continue
			options.push({
				groupId: group.id,
				groupName: group.name,
				optionId: option.id,
				optionName: option.displayName,
				quantity: qty,
				unitCents: toCents(option.price),
				taxable: option.applySalesTax !== false,
			})
		}
	}
	return {
		itemId: item.id,
		name: item.displayName,
		variantId: variant?.id ?? null,
		variantLabel: variantLabel || null,
		quantity,
		baseCents: toCents(variant ? variant.price : item.price),
		instructions: instructions.trim(),
		options,
	}
}

export const itemNeedsChoices = (item: MenuItem): boolean =>
	item.variations.groups.length > 0 ||
	item.modifierGroups.some(
		(g) => isAvailable(g.availabilityStatus) && availableOptions(g).length > 0,
	)

/** True when nothing must be chosen, so a single tap can add the item. */
export const canQuickAdd = (item: MenuItem): boolean =>
	validateConfig(item, defaultVariantPicks(item), defaultSelections(item)) ===
		null &&
	item.variations.groups.length === 0 &&
	!item.modifierGroups.some((g) => g.minSelections > 0)
