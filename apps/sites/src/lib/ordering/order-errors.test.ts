import { describe, expect, it } from 'vitest'
import {
	orderErrorLabelKey,
	orderErrorMessage,
	type OrderErrorLabels,
} from './order-errors.ts'

const labels: OrderErrorLabels = {
	orderingClosed: 'orderingClosed',
	dropClosed: 'dropClosed',
	dropNotFound: 'dropNotFound',
	pickupSlotUnavailable: 'pickupSlotUnavailable',
	pickupRequired: 'pickupRequired',
	pickupUnavailable: 'pickupUnavailable',
	deliveryUnavailable: 'deliveryUnavailable',
	deliveryAddressRequired: 'deliveryAddressRequired',
	tipsDisabled: 'tipsDisabled',
	itemsChanged: 'itemsChanged',
	orderNeedsReview: 'orderNeedsReview',
	slotFull: 'slotFull',
	soldOut: 'soldOut',
	quantityLimit: 'quantityLimit',
	minimumOrder: 'minimumOrder',
	locationUnavailable: 'locationUnavailable',
	idempotencyConflict: 'idempotencyConflict',
	rateLimited: 'rateLimited',
	generic: 'generic',
}

describe('orderErrorLabelKey', () => {
	it('maps every documented server code to a specific label', () => {
		const expectations: Record<string, keyof OrderErrorLabels> = {
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
		for (const [code, key] of Object.entries(expectations)) {
			expect(orderErrorLabelKey(code)).toBe(key)
		}
	})

	it('falls back to the generic label for unknown or missing codes', () => {
		expect(orderErrorLabelKey('something_new')).toBe('generic')
		expect(orderErrorLabelKey('region_unavailable')).toBe('generic')
		expect(orderErrorLabelKey('')).toBe('generic')
		expect(orderErrorLabelKey(null)).toBe('generic')
		expect(orderErrorLabelKey(undefined)).toBe('generic')
	})
})

describe('orderErrorMessage', () => {
	it('returns the localized message for the code', () => {
		expect(orderErrorMessage('sold_out', labels)).toBe('soldOut')
		expect(orderErrorMessage('nope', labels)).toBe('generic')
	})
})
