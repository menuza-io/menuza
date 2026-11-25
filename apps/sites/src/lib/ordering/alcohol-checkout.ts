/**
 * Alcohol at checkout (#167): which cart lines hold alcohol, so the page asks
 * "I am 21 or older and will show ID" and sends a yes. The region decides what
 * is allowed; this only decides when to ask. A yes is all that is sent, never a
 * birth date.
 */
import { type CartItem } from './types.ts'

export type AlcoholIds = { items: string[]; options: string[] }

type MenuLike = {
	menus?: Array<{
		categories?: Array<{
			items?: Array<{
				id: string
				isAlcohol?: boolean
				modifierGroups?: Array<{
					options?: Array<{ id: string; isAlcohol?: boolean }>
				}>
			}>
			subcategories?: unknown[]
		}>
	}>
}

/** Item and option ids flagged alcohol in the published menu. */
export function alcoholIdsFromMenu(menu: MenuLike | null | undefined): AlcoholIds {
	const items = new Set<string>()
	const options = new Set<string>()
	const visit = (categories: unknown) => {
		if (!Array.isArray(categories)) return
		for (const category of categories as NonNullable<
			NonNullable<MenuLike['menus']>[number]['categories']
		>) {
			for (const item of category.items ?? []) {
				if (item.isAlcohol) items.add(item.id)
				for (const group of item.modifierGroups ?? []) {
					for (const option of group.options ?? []) {
						if (option.isAlcohol) options.add(option.id)
					}
				}
			}
			visit(category.subcategories)
		}
	}
	for (const menuEntry of menu?.menus ?? []) visit(menuEntry.categories)
	return { items: [...items], options: [...options] }
}

/** Whether any line in the cart is, or has an option that is, alcohol. */
export function cartHasAlcohol(
	cart: readonly Pick<CartItem, 'itemId' | 'options'>[],
	ids: AlcoholIds | null | undefined,
): boolean {
	if (!ids) return false
	const items = new Set(ids.items)
	const options = new Set(ids.options)
	return cart.some(
		(line) =>
			items.has(line.itemId) ||
			(line.options ?? []).some((option) => options.has(option.optionId)),
	)
}

/** What the order body carries: a yes only when alcohol is in the cart and the box is ticked. */
export function ageConfirmation(
	hasAlcohol: boolean,
	ticked: boolean,
): { ageConfirmed?: true } {
	return hasAlcohol && ticked ? { ageConfirmed: true } : {}
}
