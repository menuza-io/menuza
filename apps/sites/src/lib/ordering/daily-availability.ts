import { dailyDishDemand } from '@repo/common/daily-dish-catalog'
import { dailyDishKey } from '@repo/common/daily-dish-limits'
import { type SoldOutDish } from './order-errors.ts'
import {
	type CartItem,
	type ModifierGroup,
	type OrderingCategory,
	type OrderingItem,
} from './types.ts'

/**
 * Daily limits on the guest's side (#409). The region sends, per dish or
 * option (`item:<id>` / `option:<id>`), only what a guest may know: sold out
 * for today, and a low number where the restaurant turned "Only N left" on.
 * A cap that is not shown never arrives here, so nothing below can leak one.
 */
export type DailyAvailability = Record<
	string,
	{ remaining: number; showRemaining: boolean }
>

/** What `GET /orders/options` carried, read defensively (older nodes send none). */
export function readDailyAvailability(options: unknown): DailyAvailability {
	const raw =
		options && typeof options === 'object'
			? (options as { dailyAvailability?: unknown }).dailyAvailability
			: null
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
	const out: DailyAvailability = {}
	for (const [key, value] of Object.entries(raw)) {
		if (!value || typeof value !== 'object') continue
		const { remaining, showRemaining } = value as Record<string, unknown>
		if (
			typeof remaining !== 'number' ||
			!Number.isInteger(remaining) ||
			remaining < 0
		) {
			continue
		}
		out[key] = { remaining, showRemaining: showRemaining === true }
	}
	return out
}

/** What one dish or option looks like today: sold out, or "Only N left". */
export type DailyView = { soldOut: boolean; left: number | null }

export function dailyView(
	availability: DailyAvailability,
	kind: 'item' | 'option',
	id: string,
): DailyView | null {
	const entry = availability[dailyDishKey(kind, id)]
	if (!entry) return null
	if (entry.remaining === 0) return { soldOut: true, left: null }
	return entry.showRemaining ? { soldOut: false, left: entry.remaining } : null
}

function overlayOptions(
	groups: readonly ModifierGroup[] | undefined,
	availability: DailyAvailability,
) {
	for (const group of groups ?? []) {
		for (const option of group.options ?? []) {
			option.publishedAvailability ??= option.availabilityStatus ?? 'available'
			const view = dailyView(availability, 'option', option.id)
			option.availabilityStatus = view?.soldOut
				? 'unavailable'
				: option.publishedAvailability
			option.dailyRemaining = view?.left ?? null
			overlayOptions(option.nestedModifierGroups, availability)
		}
	}
}

function overlayItem(item: OrderingItem, availability: DailyAvailability) {
	item.publishedAvailability ??= item.availabilityStatus ?? 'available'
	const view = dailyView(availability, 'item', item.id)
	item.availabilityStatus = view?.soldOut
		? 'unavailable'
		: item.publishedAvailability
	item.dailyRemaining = view?.left ?? null
	overlayOptions(item.modifierGroups, availability)
}

/**
 * Puts today's availability on the catalog the card list, the item modal and
 * the cart read. A sold-out dish or option reads `unavailable`, which every one
 * of them already shows as "Sold out" and refuses to add; a low number rides
 * along as `dailyRemaining`. Run again with a newer answer it also gives a dish
 * back (a manager topped it up), because what the menu published is kept.
 */
export function applyDailyAvailability(
	categories: readonly OrderingCategory[],
	availability: DailyAvailability,
): void {
	const seen = new Set<OrderingItem>()
	const walk = (category: OrderingCategory) => {
		for (const item of category.items ?? []) {
			if (seen.has(item)) continue
			seen.add(item)
			overlayItem(item, availability)
		}
		for (const sub of category.subcategories ?? []) walk(sub)
	}
	for (const category of categories) walk(category)
}

/**
 * The lines of a cart that today's availability already says cannot be
 * placed: a dish or chosen option that is sold out, or more units than the
 * number the restaurant shows as left. Shaped like the region's refusal
 * (`details.short`) so one message builder serves both. Anything the guest may
 * not know about is left to the region, which judges every order.
 */
export function dailyCartIssues(
	cart: readonly CartItem[],
	availability: DailyAvailability,
): SoldOutDish[] {
	if (Object.keys(availability).length === 0) return []
	const demand = dailyDishDemand(
		cart.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			options: (line.options ?? [])
				.filter((option) => !option.variation)
				.map((option) => ({
					optionId: option.optionId,
					quantity: option.quantity ?? 1,
				})),
		})),
	)
	const out: SoldOutDish[] = []
	for (const [key, units] of demand) {
		const entry = availability[key]
		if (!entry) continue
		const short =
			entry.remaining === 0 || (entry.showRemaining && units > entry.remaining)
		if (!short) continue
		const split = key.indexOf(':')
		const kind = key.slice(0, split)
		if (kind !== 'item' && kind !== 'option') continue
		out.push({
			key,
			kind,
			id: key.slice(split + 1),
			remaining:
				entry.showRemaining && entry.remaining > 0 ? entry.remaining : null,
		})
	}
	return out
}

/** A dish or option's name from the cart's own lines (the region sends ids). */
export function cartNameOf(
	cart: readonly CartItem[],
	dish: Pick<SoldOutDish, 'kind' | 'id'>,
): string | null {
	for (const line of cart) {
		if (dish.kind === 'item' && line.itemId === dish.id) return line.name
		if (dish.kind === 'option') {
			const option = (line.options ?? []).find(
				(candidate) => candidate.optionId === dish.id,
			)
			if (option) return option.optionName
		}
	}
	return null
}

/**
 * Quantity caps for the item modal and the cart (`Constraints`, the same shape
 * drops use): a sold-out dish can take no more (0), and where the restaurant
 * shows how many are left the stepper stops there and says "Only N left".
 * Filled in place, because both read the object they were given when they
 * open; run again it clears what a top-up has since freed.
 */
export function applyDailyConstraints(
	target: {
		items?: Record<string, { inventory?: number | null }>
		showInventory?: boolean
	},
	availability: DailyAvailability,
): void {
	const items: Record<string, { inventory: number }> = {}
	for (const key of Object.keys(availability)) {
		const split = key.indexOf(':')
		if (key.slice(0, split) !== 'item') continue
		const id = key.slice(split + 1)
		const view = dailyView(availability, 'item', id)
		if (view) items[id] = { inventory: view.soldOut ? 0 : (view.left ?? 0) }
	}
	target.items = items
	target.showInventory = true
}
