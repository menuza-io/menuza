/**
 * Snapshot helpers: a stable, comparable view of a remote item, used by the
 * sandbox to apply only the fields a provider actually stores. Trimmed from the
 * Mise reference project (`lib/pos/menu.ts`).
 */

import { type MenuField, type RemoteItem, type Snapshot } from './types.ts'

export function snapshotOf(item: RemoteItem): Snapshot {
	return {
		name: item.name,
		description: item.description,
		category: item.category,
		price: item.price,
		imageUrl: item.imageUrl,
		available: item.available,
		modifierGroups: item.modifierGroups.map((group) => ({
			...group,
			options: group.options.map((option) => ({
				name: option.name,
				price: option.price,
				available: option.available !== false,
			})),
		})),
		variations: item.variations ?? [],
		menus: [...item.menus].sort(),
		allergens: [...item.allergens].sort(),
		alcohol: Boolean(item.alcohol),
		taxRate: item.taxRate,
	}
}

const keyOf: Record<MenuField, keyof Snapshot> = {
	name: 'name',
	description: 'description',
	category: 'category',
	price: 'price',
	photo: 'imageUrl',
	available: 'available',
	modifiers: 'modifierGroups',
	variations: 'variations',
	menus: 'menus',
	allergens: 'allergens',
	tax: 'taxRate',
}

export function pick(
	target: Snapshot,
	source: Snapshot,
	fields: MenuField[],
): Snapshot {
	const next: Snapshot = { ...target }
	for (const field of fields) {
		;(next as Record<string, unknown>)[keyOf[field]] = source[keyOf[field]]
		if (field === 'allergens') next.alcohol = Boolean(source.alcohol)
	}
	return next
}
