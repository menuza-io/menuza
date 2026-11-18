import { t } from '@lingui/macro'
import { isAvailable } from './availability.ts'
import { toCents } from './money.ts'
import { type CartLine, type CartOption } from './pricing.ts'
import {
	type MenuCategory,
	type MenuItem,
	type MenuOption,
	type ModifierGroup,
} from './types.ts'

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
				...(option.kitchenName ? { kitchenName: option.kitchenName } : {}),
				...(option.kitchenHighlight
					? { kitchenHighlight: option.kitchenHighlight }
					: {}),
				quantity: qty,
				// The server prices a whole choice with `priceWhole ?? price` (the base
				// being the location override), so the till does too.
				unitCents: toCents(option.priceWhole ?? option.price),
				taxable: option.applySalesTax !== false,
			})
		}
	}
	return {
		itemId: item.id,
		name: item.displayName,
		...(item.kitchenName ? { kitchenName: item.kitchenName } : {}),
		...(item.kitchenHighlight
			? { kitchenHighlight: item.kitchenHighlight }
			: {}),
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

/**
 * True when the item has nothing to choose, so a single tap can add it. An item
 * with any choice the cashier can make, required or not (toppings, add-ons, a
 * size), opens its sheet instead: an optional topping that can't be reached
 * from the register is a topping the guest can't order.
 */
export const canQuickAdd = (item: MenuItem): boolean =>
	!itemNeedsChoices(item) &&
	validateConfig(item, defaultVariantPicks(item), defaultSelections(item)) ===
		null

function findOption(
	groups: readonly ModifierGroup[],
	groupId: string,
	optionId: string,
): MenuOption | null {
	for (const group of groups) {
		for (const option of group.options) {
			if (group.id === groupId && option.id === optionId) return option
			const nested = findOption(
				option.nestedModifierGroups ?? [],
				groupId,
				optionId,
			)
			if (nested) return nested
		}
	}
	return null
}

/**
 * Reprices cart lines from categories priced for another order type (#412):
 * the cashier switched dine-in to takeaway (or back). Every catalog line takes
 * the price the server will check the sale against; a dish or option no
 * longer on the menu, and custom items, keep their price.
 */
export function repriceLinesFor<T extends CartLine>(
	lines: readonly T[],
	categories: readonly MenuCategory[],
): T[] {
	const items = new Map<string, MenuItem>()
	const walk = (category: MenuCategory) => {
		for (const item of category.items)
			if (!items.has(item.id)) items.set(item.id, item)
		category.subcategories?.forEach(walk)
	}
	categories.forEach(walk)
	return lines.map((line) => {
		if (line.kind === 'custom') return line
		const item = items.get(line.itemId)
		if (!item) return line
		const variant = line.variantId
			? item.variations.variants.find((entry) => entry.id === line.variantId)
			: null
		const baseCents = line.variantId
			? variant
				? toCents(variant.price)
				: line.baseCents
			: toCents(item.price)
		let changed = baseCents !== line.baseCents
		const options = line.options.map((entry) => {
			const option = findOption(
				item.modifierGroups,
				entry.groupId,
				entry.optionId,
			)
			if (!option) return entry
			const unitCents = toCents(option.priceWhole ?? option.price)
			if (unitCents === entry.unitCents) return entry
			changed = true
			return { ...entry, unitCents }
		})
		return changed ? { ...line, baseCents, options } : line
	})
}
