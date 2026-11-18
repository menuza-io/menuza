import {
	DIETARY_TAGS,
	dietaryTagsOf,
	matchesDietaryFilter,
	type DietaryTag,
} from '@repo/common/menu-types'

/**
 * The guest dietary filter on the menu (#335). A dish shows when it matches
 * the search and has every chosen tag (a vegan dish counts as vegetarian).
 * Tags are the restaurant's claims; the page says so next to the filter.
 */

/** The `data-diet` value of a dish card: its tags, space separated. */
export function dietAttribute(item: {
	dietaryTags?: unknown
	isVegetarian?: boolean | null
	isGlutenFree?: boolean | null
}): string {
	return dietaryTagsOf(item).join(' ')
}

/** Tags used by at least one dish, in the canonical order (the filter's chips). */
export function dietaryTagsInMenu(
	items: Iterable<{
		dietaryTags?: unknown
		isVegetarian?: boolean | null
		isGlutenFree?: boolean | null
	}>,
): DietaryTag[] {
	const used = new Set<DietaryTag>()
	for (const item of items) for (const tag of dietaryTagsOf(item)) used.add(tag)
	if (used.has('vegan')) used.add('vegetarian')
	return DIETARY_TAGS.filter((tag) => used.has(tag))
}

/** Whether a card shows for this search text and these chosen tags. */
export function cardMatches(
	card: { search?: string; diet?: string },
	query: string,
	selected: readonly string[],
): boolean {
	const text = query.trim().toLocaleLowerCase()
	if (text && !(card.search ?? '').includes(text)) return false
	const tags = (card.diet ?? '').split(' ').filter(Boolean)
	return matchesDietaryFilter(tags, selected)
}
