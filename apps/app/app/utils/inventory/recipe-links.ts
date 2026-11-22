import { type UsedInRow } from '@repo/inventory'

/**
 * Where a recipe is edited: a dish on its menu page, an option on its page, a
 * made item on its stock sheet. A size (variant) belongs to a dish the region
 * does not know, so it leads to the menu list. `line` selects an ingredient
 * row in the editor (`?recipeLine=<item id>`).
 */
export function recipeHref(input: {
	orgSlug: string
	ownerKind: UsedInRow['ownerKind']
	ownerId: string
	lineItemId?: string | null
}): string {
	const base = `/${input.orgSlug}`
	const id = encodeURIComponent(input.ownerId)
	const line = input.lineItemId
		? `?recipeLine=${encodeURIComponent(input.lineItemId)}`
		: ''
	switch (input.ownerKind) {
		case 'menu_item':
			return `${base}/menu/items/${id}${line}`
		case 'option':
			return `${base}/menu/options/${id}${line}`
		case 'made_item':
			return `${base}/inventory/stock/${id}${line}`
		case 'variant':
			return `${base}/menu/items`
	}
}
