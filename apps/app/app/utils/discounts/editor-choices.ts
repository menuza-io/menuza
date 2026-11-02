import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import { variantKey } from '@repo/discounts'
import {
	type DiscountChoiceCatalog,
	type DiscountVariantGroupChoice,
} from './editor-model.ts'

/**
 * The editor's pickers beyond items and categories, from control-plane menu
 * rows: modifier groups and options, and the option types items share. Menu
 * names can be plain text or a JSON language map (`{"en":"Toppings"}`), so
 * every name is read in the website's default language here and the pickers
 * never show raw JSON. Pure, so it is tested without a database.
 */

type ModifierGroupRow = {
	id: string
	name: string
	internalName: string | null
}
type OptionRow = {
	id: string
	displayName: string
	internalName: string | null
}
type AssignmentRow = { groupId: string; optionId: string }
type ItemVariationsRow = { variations: string | null }

/** Most option types, and values per type, the pickers offer. */
const MAX_VARIANT_GROUP_CHOICES = 50
const MAX_VARIANT_VALUE_CHOICES = 200

/** A menu name in the default language, else the internal name, else the id. */
export function menuDisplayName(
	value: string | null | undefined,
	internalName: string | null | undefined,
	fallback: string,
	defaultLocale: string,
): string {
	return (
		getLocalizedMenuValue(value, defaultLocale, defaultLocale).trim() ||
		internalName?.trim() ||
		fallback
	)
}

export function buildDiscountChoices({
	groups,
	options,
	assignments,
	itemVariations,
	defaultLocale,
}: {
	groups: readonly ModifierGroupRow[]
	options: readonly OptionRow[]
	assignments: readonly AssignmentRow[]
	itemVariations: readonly ItemVariationsRow[]
	defaultLocale: string
}): DiscountChoiceCatalog {
	const groupName = new Map(
		groups.map((group) => [
			group.id,
			menuDisplayName(group.name, group.internalName, group.id, defaultLocale),
		]),
	)
	// An option is shown with the group it sits in, so two "Extra cheese"
	// options in different groups can be told apart.
	const groupsOfOption = new Map<string, string[]>()
	for (const row of assignments) {
		const name = groupName.get(row.groupId)
		if (!name) continue
		groupsOfOption.set(row.optionId, [
			...(groupsOfOption.get(row.optionId) ?? []),
			name,
		])
	}
	return {
		groups: groups.map((group) => ({
			id: group.id,
			name: groupName.get(group.id)!,
			detail: null,
		})),
		options: options.map((option) => ({
			id: option.id,
			name: menuDisplayName(
				option.displayName,
				option.internalName,
				option.id,
				defaultLocale,
			),
			detail: groupsOfOption.get(option.id)?.join(', ') ?? null,
		})),
		variantGroups: variantGroupChoices(itemVariations, defaultLocale),
	}
}

/**
 * Every option type ("Size", "Crust") the items use, with every value of it,
 * merged across items by key: each item has its own ids for them but the same
 * names, which is what a discount matches on. The most used come first.
 */
export function variantGroupChoices(
	rows: readonly ItemVariationsRow[],
	defaultLocale: string,
): DiscountVariantGroupChoice[] {
	type ValueEntry = { name: string; items: number }
	type GroupEntry = {
		name: string
		items: number
		values: Map<string, ValueEntry>
	}
	const groups = new Map<string, GroupEntry>()
	for (const row of rows) {
		for (const group of parseMenuVariations(row.variations).groups) {
			const name = getLocalizedMenuValue(
				group.name,
				defaultLocale,
				defaultLocale,
			).trim()
			const key = variantKey(name)
			if (!key) continue
			const entry = groups.get(key) ?? { name, items: 0, values: new Map() }
			entry.items += 1
			const seen = new Set<string>()
			for (const value of group.values) {
				const valueName = getLocalizedMenuValue(
					value.name,
					defaultLocale,
					defaultLocale,
				).trim()
				const valueKey = variantKey(valueName)
				if (!valueKey || seen.has(valueKey)) continue
				seen.add(valueKey)
				const valueEntry = entry.values.get(valueKey) ?? {
					name: valueName,
					items: 0,
				}
				valueEntry.items += 1
				entry.values.set(valueKey, valueEntry)
			}
			groups.set(key, entry)
		}
	}
	const byUse = <T extends { name: string; items: number }>(
		a: [string, T],
		b: [string, T],
	) => b[1].items - a[1].items || a[1].name.localeCompare(b[1].name)
	return [...groups.entries()]
		.sort(byUse)
		.slice(0, MAX_VARIANT_GROUP_CHOICES)
		.map(([key, entry]) => ({
			key,
			name: entry.name,
			items: entry.items,
			values: [...entry.values.entries()]
				.sort(byUse)
				.slice(0, MAX_VARIANT_VALUE_CHOICES)
				.map(([id, value]) => ({ id, name: value.name, detail: null })),
		}))
}
