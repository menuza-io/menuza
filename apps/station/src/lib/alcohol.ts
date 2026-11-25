import { type MenuItem, type ModifierGroup } from './types.ts'

/**
 * Whether a sale holds alcohol (#167): any dish flagged alcohol, or any chosen
 * option flagged alcohol. The ticket and receipt then say "Check ID". Staff
 * check ID at the counter themselves; nothing here refuses a sale.
 */
export function orderHasAlcohol(
	lines: ReadonlyArray<{
		itemId: string
		options?: ReadonlyArray<{ optionId: string }>
	}>,
	items: ReadonlyMap<string, MenuItem>,
): boolean {
	return lines.some((line) => {
		const item = items.get(line.itemId)
		if (!item) return false
		if (item.isAlcohol) return true
		const chosen = new Set((line.options ?? []).map((o) => o.optionId))
		if (chosen.size === 0) return false
		const hit = (groups: readonly ModifierGroup[] | undefined): boolean =>
			(groups ?? []).some((group) =>
				group.options.some(
					(option) =>
						(chosen.has(option.id) &&
							(option as { isAlcohol?: boolean }).isAlcohol === true) ||
						hit(option.nestedModifierGroups),
				),
			)
		return hit(item.modifierGroups)
	})
}
