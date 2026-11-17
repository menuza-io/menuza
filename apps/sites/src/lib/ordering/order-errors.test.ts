import { describe, expect, it } from 'vitest'
import {
	dailySoldOutMessage,
	orderErrorLabelKey,
	orderErrorMessage,
	orderErrorMessageFor,
	orderTooLargeKind,
	orderTooLargeMessage,
	soldOutDishes,
	type OrderErrorLabels,
} from './order-errors.ts'

const labels: OrderErrorLabels = {
	orderingClosed: 'orderingClosed',
	orderingPaused: 'orderingPaused',
	dropClosed: 'dropClosed',
	dropNotFound: 'dropNotFound',
	pickupSlotUnavailable: 'pickupSlotUnavailable',
	pickupRequired: 'pickupRequired',
	pickupUnavailable: 'pickupUnavailable',
	deliveryUnavailable: 'deliveryUnavailable',
	deliveryAddressRequired: 'deliveryAddressRequired',
	tipsDisabled: 'tipsDisabled',
	tipTooLarge: 'tipTooLarge',
	serviceFeeChanged: 'serviceFeeChanged',
	serviceFeeUnavailable: 'serviceFeeUnavailable',
	packagingFeeChanged: 'packagingFeeChanged',
	packagingFeeUnavailable: 'packagingFeeUnavailable',
	orderTooLarge: 'orderTooLarge',
	orderTooLargeCall: 'orderTooLargeCall:{phone}',
	orderTooLargeGuests: 'orderTooLargeGuests',
	dailyDishSoldOut: 'dailyDishSoldOut',
	dishSoldOut: 'dishSoldOut:{name}',
	dishesSoldOut: 'dishesSoldOut:{names}',
	dishOnlyLeft: 'dishOnlyLeft:{name}:{count}',
	itemsChanged: 'itemsChanged',
	orderNeedsReview: 'orderNeedsReview',
	slotFull: 'slotFull',
	soldOut: 'soldOut',
	quantityLimit: 'quantityLimit',
	minimumOrder: 'minimumOrder',
	locationUnavailable: 'locationUnavailable',
	idempotencyConflict: 'idempotencyConflict',
	rateLimited: 'rateLimited',
	discountChanged: 'discountChanged',
	couponRefused: 'couponRefused',
	discountsUnavailable: 'discountsUnavailable',
	generic: 'generic',
}

describe('orderErrorLabelKey', () => {
	it('maps every documented server code to a specific label', () => {
		const expectations: Record<string, keyof OrderErrorLabels> = {
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

describe('order_too_large (#422)', () => {
	const amount = {
		error: 'order_too_large',
		details: { kind: 'amount', fulfillment: 'pickup' },
	}
	const guests = {
		error: 'order_too_large',
		details: { kind: 'guests', fulfillment: 'dine_in' },
	}

	it('reads which limit was hit, defaulting to the order amount', () => {
		expect(orderTooLargeKind(amount)).toBe('amount')
		expect(orderTooLargeKind(guests)).toBe('guests')
		expect(orderTooLargeKind(null)).toBe('amount')
		expect(orderTooLargeKind({ details: { kind: 'other' } })).toBe('amount')
	})

	it('points a big order to the restaurant phone when it has one', () => {
		expect(orderTooLargeMessage(amount, labels, '+966 11 555 0100')).toBe(
			'orderTooLargeCall:+966 11 555 0100',
		)
	})

	it('falls back to the plain catering and phone words without a phone', () => {
		expect(orderTooLargeMessage(amount, labels, null)).toBe('orderTooLarge')
		expect(orderTooLargeMessage(amount, labels, '  ')).toBe('orderTooLarge')
		expect(orderTooLargeMessage(null, labels)).toBe('orderTooLarge')
	})

	it('asks a team member for a table that is too big, whatever the phone', () => {
		expect(orderTooLargeMessage(guests, labels, '+966 11 555 0100')).toBe(
			'orderTooLargeGuests',
		)
	})

	it('never carries a number from the region into the message', () => {
		const noisy = {
			details: { kind: 'amount', maxSubtotalMinor: 5000, limit: 50 },
		}
		expect(orderTooLargeMessage(noisy, labels, null)).not.toMatch(/5000|50/)
	})
})

describe('daily_dish_sold_out (#409)', () => {
	const body = (short: unknown[]) => ({
		error: 'daily_dish_sold_out',
		details: { short },
	})
	const names: Record<string, string> = {
		'item:i1': 'Lamb special',
		'option:o1': 'Dessert',
	}
	const nameOf = (dish: { key: string }) => names[dish.key] ?? null

	it('reads the dishes the region listed and ignores anything malformed', () => {
		expect(
			soldOutDishes(
				body([
					{ key: 'item:i1', kind: 'item', id: 'i1' },
					{ key: 'option:o1', kind: 'option', id: 'o1', remaining: 2 },
					{ key: 'x', kind: 'menu', id: 'y' },
					null,
					'nope',
					{ key: 'item:i2', kind: 'item', id: 'i2', remaining: -4 },
				]),
			),
		).toEqual([
			{ key: 'item:i1', kind: 'item', id: 'i1', remaining: null },
			{ key: 'option:o1', kind: 'option', id: 'o1', remaining: 2 },
			{ key: 'item:i2', kind: 'item', id: 'i2', remaining: null },
		])
		expect(soldOutDishes(null)).toEqual([])
		expect(soldOutDishes({ details: { short: 'x' } })).toEqual([])
	})

	it('names one sold out dish from the cart, without a number', () => {
		expect(
			dailySoldOutMessage(
				body([{ key: 'item:i1', kind: 'item', id: 'i1' }]),
				nameOf,
				labels,
			),
		).toBe('dishSoldOut:Lamb special')
	})

	it('shows "only N left" only when the region sent a number', () => {
		expect(
			dailySoldOutMessage(
				body([{ key: 'item:i1', kind: 'item', id: 'i1', remaining: 2 }]),
				nameOf,
				labels,
			),
		).toBe('dishOnlyLeft:Lamb special:2')
	})

	it('lists several named dishes together', () => {
		expect(
			dailySoldOutMessage(
				body([
					{ key: 'item:i1', kind: 'item', id: 'i1' },
					{ key: 'option:o1', kind: 'option', id: 'o1' },
				]),
				nameOf,
				labels,
			),
		).toBe('dishesSoldOut:Lamb special, Dessert')
	})

	it('falls back to the plain message when the cart cannot name the dish', () => {
		expect(
			dailySoldOutMessage(
				body([{ key: 'item:zz', kind: 'item', id: 'zz' }]),
				nameOf,
				labels,
			),
		).toBe('dailyDishSoldOut')
		expect(dailySoldOutMessage(null, nameOf, labels)).toBe('dailyDishSoldOut')
	})
})

describe('orderErrorMessageFor', () => {
	it('uses the richer words for the two codes that carry data, and the plain mapping for the rest', () => {
		expect(
			orderErrorMessageFor(
				'order_too_large',
				{ details: { kind: 'guests' } },
				labels,
			),
		).toBe('orderTooLargeGuests')
		expect(
			orderErrorMessageFor(
				'daily_dish_sold_out',
				{ details: { short: [{ key: 'item:i1', kind: 'item', id: 'i1' }] } },
				labels,
				{ nameOf: () => 'Soup' },
			),
		).toBe('dishSoldOut:Soup')
		expect(orderErrorMessageFor('sold_out', null, labels)).toBe('soldOut')
		expect(
			orderErrorMessageFor('packaging_fee_unavailable', null, labels),
		).toBe('packagingFeeUnavailable')
	})
})
