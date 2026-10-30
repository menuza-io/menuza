import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { loyaltyCatalogIdSchema } from '@repo/loyalty'

/**
 * Menu choices for the loyalty forms. Operators pick items and categories by
 * name; programs and rewards store the ids plus the names captured when they
 * were saved, so customers keep seeing a name after the menu changes.
 */

export type LoyaltyCatalogOption = {
	id: string
	name: string
	/** Second line: a category's parent path, or an item's internal name. */
	detail: string | null
}

export type LoyaltyCatalog = {
	items: LoyaltyCatalogOption[]
	categories: LoyaltyCatalogOption[]
}

type MenuRow = {
	id: string
	displayName: string
	internalName: string | null
}

type CategoryRow = MenuRow & { parentId: string | null }

/** Matches the label length `loyaltyCatalogLabelsSchema` accepts. */
const LABEL_MAX_LENGTH = 120

function isCatalogId(id: string): boolean {
	return loyaltyCatalogIdSchema.safeParse(id).success
}

function nameOf(row: MenuRow, locale: string): string {
	return (
		getLocalizedMenuValue(row.displayName, locale, locale).trim() ||
		row.internalName?.trim() ||
		row.id
	)
}

/**
 * Items in menu order; categories depth-first, each with its parent path.
 * Ids the loyalty contract cannot store are left out.
 */
export function buildLoyaltyCatalog({
	items,
	categories,
	locale,
}: {
	items: readonly MenuRow[]
	categories: readonly CategoryRow[]
	locale: string
}): LoyaltyCatalog {
	const itemOptions = items.flatMap((row) => {
		if (!isCatalogId(row.id)) return []
		const name = nameOf(row, locale)
		const internal = row.internalName?.trim() || null
		return [
			{
				id: row.id,
				name,
				detail: internal && internal !== name ? internal : null,
			},
		]
	})

	const known = new Set(categories.map((row) => row.id))
	const children = new Map<string | null, CategoryRow[]>()
	for (const row of categories) {
		const parent =
			row.parentId && row.parentId !== row.id && known.has(row.parentId)
				? row.parentId
				: null
		const siblings = children.get(parent) ?? []
		siblings.push(row)
		children.set(parent, siblings)
	}
	const categoryOptions: LoyaltyCatalogOption[] = []
	const visited = new Set<string>()
	const visit = (row: CategoryRow, path: readonly string[]) => {
		if (visited.has(row.id)) return
		visited.add(row.id)
		const name = nameOf(row, locale)
		if (isCatalogId(row.id)) {
			categoryOptions.push({
				id: row.id,
				name,
				detail: path.length > 0 ? path.join(' › ') : null,
			})
		}
		for (const child of children.get(row.id) ?? [])
			visit(child, [...path, name])
	}
	for (const root of children.get(null) ?? []) visit(root, [])
	// Categories in a parent cycle never reach a root: list them at the end.
	for (const row of categories) visit(row, [])

	return { items: itemOptions, categories: categoryOptions }
}

function clipLabel(name: string): string {
	let label = name.trim()
	if (label.length <= LABEL_MAX_LENGTH) return label
	label = label.slice(0, LABEL_MAX_LENGTH)
	// Never keep half of a surrogate pair.
	if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1)
	return label.trim()
}

/**
 * The names saved with a program or reward: each chosen id's current menu
 * name, or the name saved last time when the menu no longer has the id.
 */
export function catalogLabelsFor(
	ids: readonly string[],
	options: readonly LoyaltyCatalogOption[],
	previous: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const names = new Map(options.map((option) => [option.id, option.name]))
	const labels: Record<string, string> = {}
	for (const id of ids) {
		const saved = Object.hasOwn(previous, id) ? previous[id] : undefined
		const label = clipLabel(names.get(id) ?? saved ?? '')
		if (label) labels[id] = label
	}
	return labels
}

/** A picker's form value: the ids joined by commas (catalog ids have none). */
export function joinCatalogIds(ids: readonly string[]): string {
	return ids.join(',')
}

export function splitCatalogIds(value: string | null | undefined): string[] {
	if (!value) return []
	return [
		...new Set(
			value
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean),
		),
	]
}
