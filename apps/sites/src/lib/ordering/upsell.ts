/**
 * "Goes well with" next to the cart (#114): which dishes to suggest, from the
 * published menu's own upsell settings. The ranking is the shared one in
 * `@repo/common/upsell` (the phone agent uses it too); this file only adapts
 * the guest menu to it and applies what the guest page knows (the order type,
 * per-order limits) as a veto.
 */
import { type MenuChannel } from '@repo/common/menu-channels'
import { pickUpsells, UPSELL_MAX_SUGGESTIONS } from '@repo/common/upsell'
import { newLineId } from './cart-store.ts'
import { remainingFor } from './constraints.ts'
import {
	type CartItem,
	type CartLine,
	type Constraints,
	type OrderingCategory,
	type OrderingItem,
} from './types.ts'

/**
 * True when adding the dish needs the guest to choose something first (a
 * size or other variation, or a required option group): it opens the item
 * modal. Everything else is added in one tap.
 */
export function upsellNeedsChoices(item: OrderingItem): boolean {
	const variants = item.variations?.variants ?? []
	if ((item.variations?.groups?.length ?? 0) > 0 && variants.length > 0) {
		return true
	}
	return (item.modifierGroups ?? []).some(
		(group) => (group.minSelections ?? 0) > 0,
	)
}

/** The cart line for a dish that goes straight in: one, no choices, its own price. */
export function upsellLine(item: OrderingItem): CartItem {
	return {
		id: newLineId(),
		itemId: item.id,
		name: item.displayName,
		basePrice: item.price,
		unitPrice: item.price,
		quantity: 1,
		options: [],
		instructions: '',
	}
}

/**
 * The guest tapped Add on a suggestion. A dish that needs choices opens its
 * item modal (nothing is added yet; the add is counted when the modal adds
 * it); any other dish is added in one tap and counted at once. No price goes
 * anywhere: the cart is priced as for any added dish.
 */
export function addSuggestion(
	item: OrderingItem,
	deps: {
		add: (line: CartItem) => void
		openModal: (item: OrderingItem) => void
		/** The modal was opened from a suggestion: count its add later. */
		markOpened: (itemId: string) => void
		countAdded: (itemId: string) => void
	},
): 'opened' | 'added' {
	if (upsellNeedsChoices(item)) {
		deps.markOpened(item.id)
		deps.openModal(item)
		return 'opened'
	}
	deps.add(upsellLine(item))
	deps.countAdded(item.id)
	return 'added'
}

export function suggestForCart(input: {
	categories: readonly OrderingCategory[]
	lines: readonly CartLine[]
	/** The chosen order type is offered at this location. */
	offered: boolean
	/** Ordering channel (#220): dishes hidden on this channel are excluded. */
	channel?: MenuChannel
	/** Per-order limits and stock where the page has them (drops). */
	constraints?: Constraints | null
	/** Only dishes that go straight in (the checkout page has no item modal). */
	oneTapOnly?: boolean
	limit?: number
}): OrderingItem[] {
	if (!input.offered || input.lines.length === 0) return []
	return pickUpsells({
		menus: [{ categories: input.categories }],
		cartItemIds: input.lines.map((line) => line.itemId),
		channel: input.channel,
		limit: input.limit ?? UPSELL_MAX_SUGGESTIONS,
		allow: (item) => {
			if (input.oneTapOnly && upsellNeedsChoices(item)) return false
			// Over a per-order limit or out of stock: no room for even one more.
			const room = remainingFor(item.id, [...input.lines], input.constraints)
			return room.max === null || room.max > 0
		},
	}).map((pick) => pick.item)
}
