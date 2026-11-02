import { z } from 'zod'

/**
 * Variant filters ("only Large", "Size Large and Crust Thin"). A menu item's
 * variations are groups ("Size", "Crust") with values ("Large", "Thin"). Each
 * item has its own ids for these, but the same names across the menu, so a
 * discount names them: a group key and value keys, the names lower-cased.
 *
 * Menu names may be plain text or a language map stored as JSON
 * (`{"en":"Large","ar":"كبير"}`). A name matches a key in any of its
 * languages, so renaming a translation or changing the default language does
 * not quietly stop a discount from matching.
 */

export const DISCOUNT_MAX_VARIANT_GROUPS = 3
export const DISCOUNT_MAX_VARIANT_VALUES = 50

/**
 * The key a discount stores for a group or value name: Unicode-normalized
 * (NFKC), without Arabic tatweel or diacritics, spaces collapsed, lower-cased.
 * So "كبير" typed with harakat, or a composed and a decomposed "é", match.
 */
export function variantKey(name: string): string {
	return name
		.normalize('NFKC')
		.replace(/[\u0640\u064B-\u065F\u0670]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}

/**
 * Parsed keys per raw menu name. The engine asks for the same few names for
 * every line and discount on every evaluation (the till included), so each is
 * parsed once. Cleared when it grows past a menu's worth of names.
 */
const KEY_CACHE_LIMIT = 5000
const keyCache = new Map<string, readonly string[]>()

/**
 * Every key a menu name answers to: each language's text when the name is a
 * JSON language map, otherwise the name itself.
 */
export function variantNameKeys(
	raw: string | null | undefined,
): readonly string[] {
	if (!raw) return []
	const cached = keyCache.get(raw)
	if (cached) return cached
	const keys = parseNameKeys(raw)
	if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear()
	keyCache.set(raw, keys)
	return keys
}

function parseNameKeys(raw: string): string[] {
	const trimmed = raw.trim()
	if (!trimmed) return []
	if (trimmed.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const keys = new Set<string>()
				for (const value of Object.values(parsed)) {
					const key = typeof value === 'string' ? variantKey(value) : ''
					if (key) keys.add(key)
				}
				return [...keys]
			}
		} catch {
			/* a plain name that starts with a brace */
		}
	}
	const key = variantKey(trimmed)
	return key ? [key] : []
}

const variantKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.transform((value) => variantKey(value))

/**
 * One variant group and the values of it that qualify. A line matches when
 * its variant has one of the values in that group.
 */
export const discountVariantFilterSchema = z
	.object({
		group: variantKeySchema,
		values: z.array(variantKeySchema).min(1).max(DISCOUNT_MAX_VARIANT_VALUES),
	})
	.strict()
export type DiscountVariantFilter = z.infer<typeof discountVariantFilterSchema>

/**
 * Filters on different groups all have to match ("Large" and "Thin"); values
 * inside one group are alternatives ("Medium" or "Large").
 */
export const discountVariantFiltersSchema = z
	.array(discountVariantFilterSchema)
	.max(DISCOUNT_MAX_VARIANT_GROUPS)
	.refine(
		(filters) =>
			new Set(filters.map((filter) => filter.group)).size === filters.length,
		{ message: 'Each option type once' },
	)

/** The variant chosen on a cart line, as the menu names it (raw names). */
export type DiscountLineVariantChoice = {
	/** The group's name ("Size"), plain or a JSON language map. */
	group: string
	/** The chosen value's name ("Large"), plain or a JSON language map. */
	value: string
}

/**
 * True when there is no filter, or the line's variant satisfies every
 * filter. A line without variant detail matches no filter.
 */
export function variantFiltersMatch(
	filters: readonly DiscountVariantFilter[] | undefined,
	choices: readonly DiscountLineVariantChoice[] | undefined,
): boolean {
	if (!filters || filters.length === 0) return true
	if (!choices || choices.length === 0) return false
	const keyed = choices.map((choice) => ({
		groups: new Set(variantNameKeys(choice.group)),
		values: variantNameKeys(choice.value),
	}))
	return filters.every((filter) => {
		const wanted = new Set(filter.values)
		return keyed.some(
			(choice) =>
				choice.groups.has(filter.group) &&
				choice.values.some((value) => wanted.has(value)),
		)
	})
}

/**
 * The variant choices of an item's variant, from the item's variation groups.
 * Shared by the region's pricing and the till so both build the same lines.
 */
export function variantChoicesOf(
	groups: ReadonlyArray<{
		name: string
		values: ReadonlyArray<{ id: string; name: string }>
	}>,
	valueIds: readonly string[],
): DiscountLineVariantChoice[] {
	const choices: DiscountLineVariantChoice[] = []
	for (const group of groups) {
		for (const value of group.values) {
			if (valueIds.includes(value.id)) {
				choices.push({ group: group.name, value: value.name })
			}
		}
	}
	return choices
}
