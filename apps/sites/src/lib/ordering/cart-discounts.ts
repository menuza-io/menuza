import { localizedDiscountText } from '@repo/discounts'
import {
	type DiscountQuote,
	type DiscountQuoteState,
} from './discount-quote.ts'
import { type OrderDetailsDelivery } from './order-details.ts'
import { type CartItem, type FulfillmentMode } from './types.ts'

/**
 * What the cart drawer and the sticky tray say about discounts. The region
 * prices them (`POST /orders/quote`, see `discount-quote.ts`); this module only
 * decides what to show from the quote state, so the tray never claims a total
 * the region did not price. The browser sends no prices: the pricing payload
 * is the cart as item ids and quantities, like checkout.
 */

/** The verified delivery address as the order carries it (token signed by the region). */
export function deliveryFields(
	verified: Pick<
		OrderDetailsDelivery,
		'line1' | 'formatted' | 'quoteToken' | 'city' | 'unit'
	>,
	notes = '',
): Record<string, string> {
	const delivery: Record<string, string> = {
		address:
			verified.line1.trim().length >= 5
				? verified.line1.trim()
				: verified.formatted,
		quoteToken: verified.quoteToken,
	}
	if (verified.city.trim()) delivery.city = verified.city.trim()
	if (verified.unit?.trim()) delivery.unit = verified.unit.trim()
	if (notes.trim()) delivery.notes = notes.trim()
	return delivery
}

/**
 * The order as it would be placed now, for the menu page's quote: a pickup or
 * delivery order with the cart's lines, no contact and no tip. Null while it
 * cannot be priced (empty cart, closed store with no scheduled time, at a
 * table, delivery without a verified address).
 */
export function menuPricingPayload(input: {
	lines: Array<Pick<CartItem, 'itemId' | 'quantity'>>
	/** The order lines in the wire shape (`orderLines(cart)`). */
	orderLines: unknown[]
	locale: string
	locationId: string
	mode: FulfillmentMode
	verifiedDelivery: Parameters<typeof deliveryFields>[0] | null
	scheduledFor: string | null
	open: boolean
	atTable: boolean
	posterSource: 'qr_poster' | null
}): Record<string, unknown> | null {
	if (input.atTable || input.lines.length === 0) return null
	if (!input.open && !input.scheduledFor) return null
	const delivery = input.mode === 'delivery' ? input.verifiedDelivery : null
	if (input.mode === 'delivery' && !delivery) return null
	return {
		locale: input.locale,
		locationId: input.locationId,
		fulfillment: input.mode,
		paymentMethod: 'handoff',
		...(delivery ? { delivery: deliveryFields(delivery) } : {}),
		...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
		...(input.posterSource ? { source: input.posterSource } : {}),
		tipPercent: 0,
		lines: input.orderLines,
	}
}

export type CartDiscountNote = 'before_discounts' | 'at_checkout'

export type CartDiscountView = {
	/** The region's pricing of the cart on screen now; null unless fresh. */
	quote: DiscountQuote | null
	/** Why the totals are only an estimate; null when nothing needs saying. */
	note: CartDiscountNote | null
}

export const NO_CART_DISCOUNTS: CartDiscountView = { quote: null, note: null }

/**
 * `off` (the feature is not available) behaves exactly as before discounts:
 * no rows, no note. A fresh quote replaces the estimate. Otherwise the
 * estimate stays, labelled, so a stale quote is never shown as final.
 */
export function cartDiscountView(input: {
	state: DiscountQuoteState
	fresh: DiscountQuote | null
	mode: FulfillmentMode
	hasItems: boolean
	deliveryVerified: boolean
	atTable: boolean
	/** True when the menu carries live promotions or automatic discounts may apply. */
	discountOffersAvailable?: boolean
}): CartDiscountView {
	if (!input.hasItems || input.atTable || input.state.status === 'off') {
		return NO_CART_DISCOUNTS
	}
	const offers = input.discountOffersAvailable !== false
	if (input.mode === 'delivery' && !input.deliveryVerified) {
		return offers ? { quote: null, note: 'at_checkout' } : NO_CART_DISCOUNTS
	}
	if (input.fresh) return { quote: input.fresh, note: null }
	if (input.state.status === 'idle') return NO_CART_DISCOUNTS
	if (!offers) return NO_CART_DISCOUNTS
	return { quote: null, note: 'before_discounts' }
}

/** The amounts the cart shows, in major units. */
export type CartAmounts = {
	subtotal: number
	tax: number
	deliveryFee: number
	total: number
	count: number
}

export type CartDiscountAmounts = CartAmounts & {
	/** Items and delivery discounts together, positive. */
	discount: number
	/** One name per discount, in the region's order. */
	names: string[]
}

/**
 * The region's amounts for a fresh quote; the estimate otherwise. Subtotal
 * and count stay the cart's own (the region prices the same lines).
 */
export function applyCartQuote(
	base: CartAmounts,
	quote: DiscountQuote | null,
	language: { locale?: string | null; defaultLocale?: string | null } = {},
): CartDiscountAmounts {
	if (!quote) return { ...base, discount: 0, names: [] }
	const names = [
		...new Set(
			quote.discounts.map((discount) =>
				localizedDiscountText(
					discount.nameI18n,
					discount.name,
					language.locale,
					language.defaultLocale,
				),
			),
		),
	]
	return {
		subtotal: base.subtotal,
		tax: quote.taxMinor / 100,
		deliveryFee: quote.deliveryFeeMinor / 100,
		total: quote.totalMinor / 100,
		count: base.count,
		discount: quote.totalDiscountMinor / 100,
		names,
	}
}

/** Discount names are listed only while they fit the row. */
export const MAX_LISTED_DISCOUNT_NAMES = 3

export function listedDiscountNames(names: string[]): string[] {
	return names.length > 0 && names.length <= MAX_LISTED_DISCOUNT_NAMES
		? names
		: []
}

/**
 * A budget of quote requests per window. The region limits each address to
 * 60 requests a minute; the menu page keeps well under that so checkout
 * (which shares the limit) is never starved.
 */
export function createQuoteBudget(options: {
	max: number
	windowMs: number
	now?: () => number
}) {
	const now = options.now ?? Date.now
	const times: number[] = []
	return {
		/** Spends one request; 0 when allowed, else the milliseconds to wait. */
		take(): number {
			const at = now()
			while (times.length > 0 && at - times[0]! >= options.windowMs) {
				times.shift()
			}
			if (times.length >= options.max) {
				return options.windowMs - (at - times[0]!)
			}
			times.push(at)
			return 0
		},
	}
}
