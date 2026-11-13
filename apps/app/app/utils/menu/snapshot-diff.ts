import { type MenuSnapshotContent } from './snapshot-types.ts'

export type EntityKind =
	| 'item'
	| 'category'
	| 'modifier_group'
	| 'option'
	| 'menu'

export type FieldChange = { field: string; before: unknown; after: unknown }

export type EntityDiff = {
	kind: EntityKind
	id: string
	name: string
	changes: FieldChange[]
}

export type MenuSnapshotDiff = {
	added: EntityDiff[]
	removed: EntityDiff[]
	changed: EntityDiff[]
}

function itemName(row: MenuSnapshotContent['items'][number]) {
	return row.displayName
}

function categoryName(row: MenuSnapshotContent['categories'][number]) {
	return row.displayName
}

function modifierName(row: MenuSnapshotContent['modifierGroups'][number]) {
	return row.name
}

function optionName(row: MenuSnapshotContent['options'][number]) {
	return row.displayName
}

function menuName(row: MenuSnapshotContent['menus'][number]) {
	return row.displayName
}

function compareRecords<T extends { id: string }>(
	kind: EntityKind,
	left: Map<string, T>,
	right: Map<string, T>,
	nameOf: (row: T) => string,
	fields: (keyof T & string)[],
): MenuSnapshotDiff {
	const added: EntityDiff[] = []
	const removed: EntityDiff[] = []
	const changed: EntityDiff[] = []

	for (const [id, row] of right) {
		if (!left.has(id)) {
			added.push({ kind, id, name: nameOf(row), changes: [] })
		}
	}
	for (const [id, row] of left) {
		if (!right.has(id)) {
			removed.push({ kind, id, name: nameOf(row), changes: [] })
			continue
		}
		const other = right.get(id)!
		const changes: FieldChange[] = []
		for (const field of fields) {
			const before = row[field]
			const after = other[field]
			const same =
				before instanceof Date && after instanceof Date
					? before.getTime() === after.getTime()
					: JSON.stringify(before) === JSON.stringify(after)
			if (!same) changes.push({ field, before, after })
		}
		if (changes.length > 0) {
			changed.push({ kind, id, name: nameOf(row), changes })
		}
	}

	return { added, removed, changed }
}

function mergeDiffs(parts: MenuSnapshotDiff[]): MenuSnapshotDiff {
	return parts.reduce(
		(acc, part) => ({
			added: [...acc.added, ...part.added],
			removed: [...acc.removed, ...part.removed],
			changed: [...acc.changed, ...part.changed],
		}),
		{ added: [], removed: [], changed: [] },
	)
}

/** Field-level diff between two whole-menu snapshots (a vs b). */
export function diffMenuSnapshots(
	a: MenuSnapshotContent,
	b: MenuSnapshotContent,
): MenuSnapshotDiff {
	return mergeDiffs([
		compareRecords(
			'menu',
			new Map(a.menus.map((row) => [row.id, row])),
			new Map(b.menus.map((row) => [row.id, row])),
			menuName,
			['displayName', 'availabilityStatus', 'menuType', 'position'],
		),
		compareRecords(
			'category',
			new Map(a.categories.map((row) => [row.id, row])),
			new Map(b.categories.map((row) => [row.id, row])),
			categoryName,
			['displayName', 'parentId', 'availabilityStatus', 'position'],
		),
		compareRecords(
			'item',
			new Map(a.items.map((row) => [row.id, row])),
			new Map(b.items.map((row) => [row.id, row])),
			itemName,
			[
				'displayName',
				'price',
				'availabilityStatus',
				'description',
				'isVegetarian',
				'isGlutenFree',
				'isAlcohol',
				'isPopular',
				'isUpsell',
				'applySalesTax',
			],
		),
		compareRecords(
			'modifier_group',
			new Map(a.modifierGroups.map((row) => [row.id, row])),
			new Map(b.modifierGroups.map((row) => [row.id, row])),
			modifierName,
			['name', 'selectionType', 'minSelections', 'maxSelections', 'availabilityStatus'],
		),
		compareRecords(
			'option',
			new Map(a.options.map((row) => [row.id, row])),
			new Map(b.options.map((row) => [row.id, row])),
			optionName,
			['displayName', 'price', 'availabilityStatus', 'isVegetarian', 'isGlutenFree', 'isAlcohol'],
		),
	])
}
