import {
	fixedOverridePrice,
	MENU_ORDER_TYPES,
	parseMenuPricingRules,
	resolveMenuItemPrice,
	resolveMenuOptionPrice,
	type MenuOrderType,
} from '@repo/common/menu-pricing'
import {
	type CartItem,
	type ModifierGroup,
	type OrderingCategory,
	type OrderingItem,
} from './types.ts'

/**
 * The menu's prices for one location (#412, #388), worked out on the server
 * with the same resolver the region charges with (`@repo/common/menu-pricing`):
 * the location's fixed prices, the order-type prices and the pricing rules.
 * Only what differs from the published price is listed, so most menus carry an
 * empty book. The page applies it for the current order type and reprices the
 * cart when the guest switches between pickup, delivery and the table.
 */

export type ModePrices = Record<MenuOrderType, number>

export type PriceBook = {
	/** Dish id: prices per order type (no variations) or per variation. */
	items: Record<
		string,
		{ modes?: ModePrices; variants?: Record<string, number> }
	>
	/**
	 * `groupId:optionId`: the option's price per order type in that group, and
	 * its explicit whole and half prices (pizza toppings), which win as at the
	 * region.
	 */
	options: Record<
		string,
		{
			modes: ModePrices
			whole?: number | null
			left?: number | null
			right?: number | null
		}
	>
}

/** The parts of the published menu the book reads (structural, no runtime import). */
type BookOption = {
	id: string
	price: number
	orderTypePrices?: unknown
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	nestedModifierGroups?: BookGroup[]
}
type BookGroup = { id: string; options?: BookOption[] }
type BookItem = {
	id: string
	price: number
	orderTypePrices?: unknown
	variations?: { variants?: Array<{ id: string; price: number }> }
	modifierGroups?: BookGroup[]
}
type BookCategory = {
	id: string
	items?: BookItem[]
	subcategories?: BookCategory[]
}
export type PriceBookMenu = {
	menus: Array<{ categories?: BookCategory[] }>
	locationOverrides?: Record<
		string,
		Array<{ entityId: string; price?: number | null }>
	>
	pricingRules?: unknown
}

export const EMPTY_PRICE_BOOK: PriceBook = { items: {}, options: {} }

const optionKey = (groupId: string, optionId: string) =>
	`${groupId}:${optionId}`

function sameEverywhere(modes: ModePrices, published: number): boolean {
	return MENU_ORDER_TYPES.every(
		(type) => Math.abs(modes[type] - published) < 0.0001,
	)
}

/** Server: the price book of `locationId` from the published menu. */
export function buildPriceBook(
	payload: PriceBookMenu,
	locationId: string | null | undefined,
	now: Date = new Date(),
): PriceBook {
	const book: PriceBook = { items: {}, options: {} }
	if (!locationId) return book
	const overrides = payload.locationOverrides?.[locationId] ?? []
	const overridePrice = (id: string) =>
		fixedOverridePrice(overrides.find((entry) => entry.entityId === id)?.price)
	const rules = parseMenuPricingRules(payload.pricingRules)

	const categoriesOf = new Map<string, Set<string>>()
	const items = new Map<string, BookItem>()
	const walk = (category: BookCategory) => {
		for (const item of category.items ?? []) {
			items.set(item.id, item)
			const set = categoriesOf.get(item.id) ?? new Set<string>()
			set.add(category.id)
			categoriesOf.set(item.id, set)
		}
		for (const sub of category.subcategories ?? []) walk(sub)
	}
	for (const menu of payload.menus) {
		for (const category of menu.categories ?? []) walk(category)
	}

	const visitGroups = (groups: BookGroup[] | undefined) => {
		for (const group of groups ?? []) {
			for (const option of group.options ?? []) {
				const key = optionKey(group.id, option.id)
				if (!book.options[key]) {
					const modes = Object.fromEntries(
						MENU_ORDER_TYPES.map((type) => [
							type,
							resolveMenuOptionPrice(
								option,
								{ orderType: type },
								{
									overridePrice: overridePrice(option.id),
								},
							),
						]),
					) as ModePrices
					if (!sameEverywhere(modes, option.price)) {
						book.options[key] = {
							modes,
							...(option.priceWhole != null
								? { whole: option.priceWhole }
								: {}),
							...(option.priceLeft != null ? { left: option.priceLeft } : {}),
							...(option.priceRight != null
								? { right: option.priceRight }
								: {}),
						}
					}
				}
				visitGroups(option.nestedModifierGroups)
			}
		}
	}

	for (const [id, item] of items) {
		const scope = { ...item, categoryIds: [...(categoriesOf.get(id) ?? [])] }
		const variants = item.variations?.variants ?? []
		if (variants.length > 0) {
			const prices: Record<string, number> = {}
			for (const variant of variants) {
				const price = resolveMenuItemPrice(
					scope,
					{ orderType: 'pickup', locationId, rules, now },
					{ variantPrice: variant.price, overridePrice: overridePrice(id) },
				)
				if (Math.abs(price - variant.price) >= 0.0001)
					prices[variant.id] = price
			}
			if (Object.keys(prices).length > 0) book.items[id] = { variants: prices }
		} else {
			const modes = Object.fromEntries(
				MENU_ORDER_TYPES.map((type) => [
					type,
					resolveMenuItemPrice(
						scope,
						{ orderType: type, locationId, rules, now },
						{ overridePrice: overridePrice(id) },
					),
				]),
			) as ModePrices
			if (!sameEverywhere(modes, item.price)) book.items[id] = { modes }
		}
		visitGroups(item.modifierGroups)
	}
	return book
}

/** The order type a Sites order type prices as: a table order is dine-in. */
export function priceModeOf(mode: string, atTable = false): MenuOrderType {
	if (atTable || mode === 'dine_in') return 'dine_in'
	return mode === 'delivery' ? 'delivery' : 'pickup'
}

function applyToGroups(
	groups: ModifierGroup[] | undefined,
	book: PriceBook,
	mode: MenuOrderType,
) {
	for (const group of groups ?? []) {
		for (const option of group.options ?? []) {
			const entry = book.options[optionKey(group.id, option.id)]
			if (entry) option.price = entry.modes[mode]
			applyToGroups(option.nestedModifierGroups, book, mode)
		}
	}
}

/**
 * Sets every listed price on the page's own catalog for `mode`, in place, so
 * the item modal, the upsell row, daily limits and cart restore all read the
 * same objects. Book prices are absolute, so applying again is harmless.
 */
export function applyPriceBook(
	categories: OrderingCategory[],
	book: PriceBook,
	mode: MenuOrderType,
): void {
	const seen = new Set<OrderingItem>()
	const walk = (category: OrderingCategory) => {
		for (const item of category.items ?? []) {
			if (seen.has(item)) continue
			seen.add(item)
			const entry = book.items[item.id]
			if (entry?.modes) item.price = entry.modes[mode]
			if (entry?.variants) {
				for (const variant of item.variations?.variants ?? []) {
					const price = entry.variants[variant.id]
					if (price !== undefined) variant.price = price
				}
				const available = (item.variations?.variants ?? []).filter(
					(variant) => variant.availabilityStatus !== 'unavailable',
				)
				const pool = available.length
					? available
					: (item.variations?.variants ?? [])
				if (pool.length)
					item.price = Math.min(...pool.map((variant) => variant.price))
			}
			applyToGroups(item.modifierGroups, book, mode)
		}
		for (const sub of category.subcategories ?? []) walk(sub)
	}
	for (const category of categories) walk(category)
}

/** A dish's headline price for `mode` (minor units), when the book lists it. */
export function bookItemMinor(
	book: PriceBook,
	itemId: string,
	mode: MenuOrderType,
): number | null {
	const modes = book.items[itemId]?.modes
	return modes ? Math.round(modes[mode] * 100) : null
}

/**
 * Reprices saved cart lines for `mode`: a dish's or option's price comes from
 * the book when listed, otherwise the line keeps what it had. Lines added in
 * another order type therefore follow the switch (the region charges the same).
 */
export function repriceCartForMode(
	lines: readonly CartItem[],
	book: PriceBook,
	mode: MenuOrderType,
): { lines: CartItem[]; changed: boolean } {
	let changed = false
	const next = lines.map((line) => {
		const entry = book.items[line.itemId]
		let basePrice = line.basePrice
		if (line.variantId) {
			const price = entry?.variants?.[line.variantId]
			if (price !== undefined) basePrice = price
		} else if (entry?.modes) {
			basePrice = entry.modes[mode]
		}
		const options = line.options.map((option) => {
			if (option.variation) return option
			const halves = book.options[optionKey(option.groupId, option.optionId)]
			if (!halves) return option
			const base = halves.modes[mode]
			const unit =
				option.half === 'left'
					? (halves.left ?? base)
					: option.half === 'right'
						? (halves.right ?? base)
						: option.half === 'whole'
							? (halves.whole ?? base)
							: base
			const priceDelta = Math.round(unit * (option.quantity ?? 1) * 100) / 100
			return priceDelta === option.priceDelta
				? option
				: { ...option, priceDelta }
		})
		const unitPrice =
			Math.round(
				(basePrice +
					options.reduce(
						(sum, option) => sum + (option.variation ? 0 : option.priceDelta),
						0,
					)) *
					100,
			) / 100
		if (
			basePrice === line.basePrice &&
			unitPrice === line.unitPrice &&
			options.every((option, index) => option === line.options[index])
		) {
			return line
		}
		changed = true
		return { ...line, basePrice, unitPrice, options }
	})
	return { lines: next, changed }
}
