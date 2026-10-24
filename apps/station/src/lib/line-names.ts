import { menuText } from './menu-text.ts'
import { type CartOption } from './pricing.ts'
import { type MenuItem, type ModifierGroup } from './types.ts'

/**
 * The names an order line carries, in one language. A line records the
 * restaurant's default language (receipts of record, ZATCA invoices, the
 * kitchen and the server all read the same words, whichever till rang it
 * up); each till shows it in its own language, looked up by id, falling back
 * to the recorded text (and decoding text saved before names were resolved).
 */

type NamedLine = {
	itemId: string
	name: string
	variantId: string | null
	variantLabel: string | null
	options: CartOption[]
}

/** Every modifier group of an item, nested ones included. */
function allGroups(groups: ModifierGroup[]): ModifierGroup[] {
	return groups.flatMap((group) => [
		group,
		...allGroups(
			group.options.flatMap((option) => option.nestedModifierGroups ?? []),
		),
	])
}

/** The line's names taken from this item (one language); unknown ids keep theirs. */
export function renameLine<T extends NamedLine>(
	line: T,
	item: MenuItem | undefined,
): T {
	if (!item || item.id !== line.itemId) return line
	const variant = line.variantId
		? item.variations.variants.find((v) => v.id === line.variantId)
		: undefined
	const variantLabel = variant
		? item.variations.groups
				.map((g) => g.values.find((v) => variant.valueIds.includes(v.id))?.name)
				.filter(Boolean)
				.join(' · ') || line.variantLabel
		: line.variantLabel
	const groups = allGroups(item.modifierGroups)
	return {
		...line,
		name: item.displayName || line.name,
		variantLabel,
		options: line.options.map((option) => {
			const group = groups.find((g) => g.id === option.groupId)
			const found = group?.options.find((o) => o.id === option.optionId)
			return {
				...option,
				groupName: group?.name ?? option.groupName,
				optionName: found?.displayName ?? option.optionName,
			}
		}),
	}
}

/** A line as stored, decoded where it was saved as raw translations. */
export function decodedLine<T extends NamedLine>(line: T): T {
	return {
		...line,
		name: menuText(line.name),
		variantLabel:
			line.variantLabel === null
				? null
				: line.variantLabel
						.split(' · ')
						.map((part) => menuText(part))
						.join(' · '),
		options: line.options.map((option) => ({
			...option,
			groupName: menuText(option.groupName),
			optionName: menuText(option.optionName),
		})),
	}
}
