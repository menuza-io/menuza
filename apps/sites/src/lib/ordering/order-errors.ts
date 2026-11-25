import { fillTemplate } from './money.ts'

/**
 * Maps regional ordering error codes (`POST /orders` failures) to checkout
 * label keys. The server is authoritative; this only chooses which localized
 * message to show. Unknown codes fall back to the generic message.
 */

export type OrderErrorLabels = {
	/** ordering_closed */
	orderingClosed: string
	/** ordering_paused: an operator paused web and QR ordering */
	orderingPaused: string
	/** drop_closed */
	dropClosed: string
	/** drop_not_found */
	dropNotFound: string
	/** lead_time, invalid_pickup_window, invalid_pickup_slot */
	pickupSlotUnavailable: string
	/** pickup_required */
	pickupRequired: string
	/** pickup_not_supported, pickup_disabled */
	pickupUnavailable: string
	/** delivery_disabled, delivery_not_allowed, delivery_unavailable, delivery_coverage_unverified */
	deliveryUnavailable: string
	/** delivery_address_required */
	deliveryAddressRequired: string
	/** tips_disabled */
	tipsDisabled: string
	/** tip_too_large: a custom tip above the cap */
	tipTooLarge: string
	/** delivery_fee_changed: the page shows its own message once it has the new fee */
	deliveryFeeChanged: string
	/** service_fee_changed: the page shows its own message once it has the new fee */
	serviceFeeChanged: string
	/** service_fee_unavailable: the node cannot read the location's fee */
	serviceFeeUnavailable: string
	/** packaging_fee_changed: the page shows its own message once it has the new fee */
	packagingFeeChanged: string
	/** packaging_fee_unavailable: the node cannot read the location's packaging fee */
	packagingFeeUnavailable: string
	/** order_too_large (amount): over the location's size limit; call or ask about catering */
	orderTooLarge: string
	/** order_too_large (amount) when the location has a phone: `{phone}` */
	orderTooLargeCall: string
	/** order_too_large (guests): a table past the head-count limit */
	orderTooLargeGuests: string
	/** daily_dish_sold_out without a dish the page can name */
	dailyDishSoldOut: string
	/** daily_dish_sold_out, one named dish or option: `{name}` */
	dishSoldOut: string
	/** daily_dish_sold_out, several named: `{names}` */
	dishesSoldOut: string
	/** daily_dish_sold_out when the restaurant shows how many are left: `{name}`, `{count}` */
	dishOnlyLeft: string
	/** item / variant / option / modifier availability and shape problems */
	itemsChanged: string
	/** instructions_not_allowed, invalid_quantity, invalid_request */
	orderNeedsReview: string
	/** slot_full */
	slotFull: string
	/** sold_out */
	soldOut: string
	/** per_order_limit, total_quantity_limit */
	quantityLimit: string
	/** minimum_order */
	minimumOrder: string
	/** location_not_found */
	locationUnavailable: string
	/** idempotency_conflict (409: same key, different payload) */
	idempotencyConflict: string
	/** rate_limit_exceeded */
	rateLimited: string
	/** discount_changed: the page shows its own message with the new total. */
	discountChanged: string
	/** coupon_refused: the page shows the reason; this is the fallback. */
	couponRefused: string
	/** discounts_disabled, discounts_on_tab */
	discountsUnavailable: string
	/** alcohol_not_allowed (#167): `{names}` are the lines the order type does not allow */
	alcoholNotAllowed: string
	/** age_confirmation_required (#167): the "I am 21 or older" box was not ticked */
	ageConfirmationRequired: string
	/** anything else */
	generic: string
}

export type OrderErrorLabelKey = keyof OrderErrorLabels

const CODE_TO_LABEL: Record<string, OrderErrorLabelKey> = {
	ordering_closed: 'orderingClosed',
	ordering_paused: 'orderingPaused',
	drop_closed: 'dropClosed',
	drop_not_found: 'dropNotFound',
	lead_time: 'pickupSlotUnavailable',
	invalid_pickup_window: 'pickupSlotUnavailable',
	invalid_pickup_slot: 'pickupSlotUnavailable',
	pickup_required: 'pickupRequired',
	pickup_not_supported: 'pickupUnavailable',
	pickup_disabled: 'pickupUnavailable',
	delivery_disabled: 'deliveryUnavailable',
	delivery_not_allowed: 'deliveryUnavailable',
	delivery_unavailable: 'deliveryUnavailable',
	delivery_coverage_unverified: 'deliveryUnavailable',
	delivery_address_required: 'deliveryAddressRequired',
	tips_disabled: 'tipsDisabled',
	tip_too_large: 'tipTooLarge',
	delivery_fee_changed: 'deliveryFeeChanged',
	service_fee_changed: 'serviceFeeChanged',
	service_fee_unavailable: 'serviceFeeUnavailable',
	packaging_fee_changed: 'packagingFeeChanged',
	packaging_fee_unavailable: 'packagingFeeUnavailable',
	order_too_large: 'orderTooLarge',
	daily_dish_sold_out: 'dailyDishSoldOut',
	unknown_item: 'itemsChanged',
	item_unavailable: 'itemsChanged',
	variant_required: 'itemsChanged',
	unknown_variant: 'itemsChanged',
	variant_unavailable: 'itemsChanged',
	unknown_option: 'itemsChanged',
	option_unavailable: 'itemsChanged',
	unknown_modifier_group: 'itemsChanged',
	duplicate_option: 'itemsChanged',
	invalid_half: 'itemsChanged',
	invalid_combination: 'itemsChanged',
	required_modifier: 'itemsChanged',
	modifier_limit: 'itemsChanged',
	option_quantity_limit: 'itemsChanged',
	instructions_not_allowed: 'orderNeedsReview',
	invalid_quantity: 'orderNeedsReview',
	invalid_request: 'orderNeedsReview',
	slot_full: 'slotFull',
	sold_out: 'soldOut',
	per_order_limit: 'quantityLimit',
	total_quantity_limit: 'quantityLimit',
	minimum_order: 'minimumOrder',
	location_not_found: 'locationUnavailable',
	idempotency_conflict: 'idempotencyConflict',
	rate_limit_exceeded: 'rateLimited',
	discount_changed: 'discountChanged',
	coupon_refused: 'couponRefused',
	discounts_disabled: 'discountsUnavailable',
	discounts_on_tab: 'discountsUnavailable',
	alcohol_not_allowed: 'alcoholNotAllowed',
	age_confirmation_required: 'ageConfirmationRequired',
}

export function orderErrorLabelKey(
	code: string | null | undefined,
): OrderErrorLabelKey {
	return (code && CODE_TO_LABEL[code]) || 'generic'
}

export function orderErrorMessage(
	code: string | null | undefined,
	labels: OrderErrorLabels,
): string {
	return labels[orderErrorLabelKey(code)]
}

function detailsOf(body: unknown): Record<string, unknown> | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const details = (body as { details?: unknown }).details
	return details && typeof details === 'object' && !Array.isArray(details)
		? (details as Record<string, unknown>)
		: null
}

/** Which limit `order_too_large` hit: an order amount, or a table's head count. */
export function orderTooLargeKind(body: unknown): 'amount' | 'guests' {
	return detailsOf(body)?.kind === 'guests' ? 'guests' : 'amount'
}

/**
 * `order_too_large` (#422): points a big order to the restaurant's phone or to
 * catering, and a big table to a team member. It never says what the limit is:
 * the region does not send it and the page would not repeat it.
 */
export function orderTooLargeMessage(
	body: unknown,
	labels: Pick<
		OrderErrorLabels,
		'orderTooLarge' | 'orderTooLargeCall' | 'orderTooLargeGuests'
	>,
	phone: string | null = null,
): string {
	if (orderTooLargeKind(body) === 'guests') return labels.orderTooLargeGuests
	const number = phone?.trim()
	return number
		? fillTemplate(labels.orderTooLargeCall, { phone: number })
		: labels.orderTooLarge
}

/** A dish or option that cannot cover the order today, as the region names it. */
export type SoldOutDish = {
	/** `item:<id>` or `option:<id>` */
	key: string
	kind: 'item' | 'option'
	id: string
	/** Only when the restaurant lets guests see "Only N left"; never otherwise. */
	remaining: number | null
}

/** The `details.short` list of `daily_dish_sold_out`, read defensively. */
export function soldOutDishes(body: unknown): SoldOutDish[] {
	const short = detailsOf(body)?.short
	if (!Array.isArray(short)) return []
	const out: SoldOutDish[] = []
	for (const entry of short) {
		if (!entry || typeof entry !== 'object') continue
		const { key, kind, id, remaining } = entry as Record<string, unknown>
		if (
			typeof key !== 'string' ||
			typeof id !== 'string' ||
			(kind !== 'item' && kind !== 'option')
		) {
			continue
		}
		out.push({
			key,
			kind,
			id,
			remaining:
				typeof remaining === 'number' &&
				Number.isInteger(remaining) &&
				remaining > 0
					? remaining
					: null,
		})
	}
	return out
}

/**
 * `daily_dish_sold_out` (#409): names the dish from the cart's own names (the
 * region sends ids), and the number left only when the region sent one.
 */
export function dailySoldOutMessage(
	body: unknown,
	nameOf: (dish: SoldOutDish) => string | null,
	labels: Pick<
		OrderErrorLabels,
		'dailyDishSoldOut' | 'dishSoldOut' | 'dishesSoldOut' | 'dishOnlyLeft'
	>,
): string {
	const named = soldOutDishes(body)
		.map((dish) => ({ dish, name: nameOf(dish) }))
		.filter((entry): entry is { dish: SoldOutDish; name: string } =>
			Boolean(entry.name),
		)
	const first = named[0]
	if (!first) return labels.dailyDishSoldOut
	if (named.length > 1) {
		return fillTemplate(labels.dishesSoldOut, {
			names: named.map((entry) => entry.name).join(', '),
		})
	}
	return first.dish.remaining !== null
		? fillTemplate(labels.dishOnlyLeft, {
				name: first.name,
				count: String(first.dish.remaining),
			})
		: fillTemplate(labels.dishSoldOut, { name: first.name })
}

/**
 * The message for a failed order or quote: the plain code mapping, except the
 * two codes whose words depend on what the region sent along.
 */
export function orderErrorMessageFor(
	code: string | null | undefined,
	body: unknown,
	labels: OrderErrorLabels,
	context: {
		/** The location's phone, for "call us". */
		phone?: string | null
		/** The cart's own name for a dish or option id. */
		nameOf?: (dish: SoldOutDish) => string | null
	} = {},
): string {
	if (code === 'order_too_large') {
		return orderTooLargeMessage(body, labels, context.phone ?? null)
	}
	if (code === 'daily_dish_sold_out') {
		return dailySoldOutMessage(body, context.nameOf ?? (() => null), labels)
	}
	if (code === 'alcohol_not_allowed') {
		return fillTemplate(labels.alcoholNotAllowed, {
			names: alcoholLineNames(body).join(', '),
		})
	}
	return orderErrorMessage(code, labels)
}

/** The lines `alcohol_not_allowed` names (#167), as the region sent them. */
export function alcoholLineNames(body: unknown): string[] {
	const lines = detailsOf(body)?.lines
	if (!Array.isArray(lines)) return []
	const names: string[] = []
	for (const entry of lines) {
		const name =
			entry && typeof entry === 'object'
				? (entry as { name?: unknown }).name
				: undefined
		if (typeof name === 'string' && name.trim() && !names.includes(name)) {
			names.push(name.trim().slice(0, 120))
		}
	}
	return names
}
