/**
 * Maps regional ordering error codes (`POST /orders` failures) to checkout
 * label keys. The server is authoritative; this only chooses which localized
 * message to show. Unknown codes fall back to the generic message.
 */

export type OrderErrorLabels = {
	/** ordering_closed */
	orderingClosed: string
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
	/** anything else */
	generic: string
}

export type OrderErrorLabelKey = keyof OrderErrorLabels

const CODE_TO_LABEL: Record<string, OrderErrorLabelKey> = {
	ordering_closed: 'orderingClosed',
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
