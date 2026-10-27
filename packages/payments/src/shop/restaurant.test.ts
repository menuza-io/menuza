import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import {
	buildRestaurantOrderMetadata,
	buildRestaurantOrderSessionIdempotencyKey,
	isRestaurantOrderMetadata,
	isRestaurantOrderProcessor,
	isTerminalRestaurantPaymentStatus,
	mapCheckoutPaymentToRestaurantOrder,
	mapCheckoutWebhookToRestaurantOrder,
	restaurantOrderCheckoutReference,
	mapConnectSessionToRestaurantOrder,
	RESTAURANT_ORDER_METADATA_TYPE,
	RESTAURANT_ORDER_PRODUCT_NAME,
} from './restaurant'

function stripeSession(
	overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
	return {
		id: 'cs_test_123',
		object: 'checkout.session',
		status: 'open',
		payment_status: 'unpaid',
		amount_total: 4250,
		currency: 'usd',
		metadata: {
			type: RESTAURANT_ORDER_METADATA_TYPE,
			orgId: 'org_1',
			orderId: 'ord_1',
		},
		...overrides,
	} as Stripe.Checkout.Session
}

describe('restaurant order metadata', () => {
	it('builds only opaque identifiers', () => {
		expect(buildRestaurantOrderMetadata('org_1', 'ord_1')).toEqual({
			type: 'restaurant_order',
			orgId: 'org_1',
			orderId: 'ord_1',
		})
	})

	it('recognizes restaurant metadata and nothing else', () => {
		expect(isRestaurantOrderMetadata({ type: 'restaurant_order' })).toBe(true)
		expect(isRestaurantOrderMetadata({ type: 'shop_order' })).toBe(false)
		expect(isRestaurantOrderMetadata(null)).toBe(false)
		expect(isRestaurantOrderMetadata(undefined)).toBe(false)
	})

	it('uses a fixed generic product name', () => {
		expect(RESTAURANT_ORDER_PRODUCT_NAME).toBe('Restaurant order')
	})

	it('accepts only processors that can host restaurant carts', () => {
		expect(isRestaurantOrderProcessor('connect')).toBe(true)
		expect(isRestaurantOrderProcessor('checkout')).toBe(true)
		expect(isRestaurantOrderProcessor('mor')).toBe(false)
		expect(isRestaurantOrderProcessor('polar')).toBe(false)
		expect(isRestaurantOrderProcessor(null)).toBe(false)
	})
})

describe('buildRestaurantOrderSessionIdempotencyKey', () => {
	it('is deterministic for the same order facts', () => {
		const input = {
			orgId: 'org_1',
			orderId: 'ord_1',
			amountCents: 4250,
			currency: 'USD',
			holdExpiresAt: '2026-10-08T12:00:00.000Z',
		}
		expect(buildRestaurantOrderSessionIdempotencyKey(input)).toBe(
			buildRestaurantOrderSessionIdempotencyKey(input),
		)
	})

	it('changes when the quote facts change', () => {
		const base = {
			orgId: 'org_1',
			orderId: 'ord_1',
			amountCents: 4250,
			currency: 'USD',
			holdExpiresAt: '2026-10-08T12:00:00.000Z',
		}
		expect(buildRestaurantOrderSessionIdempotencyKey(base)).not.toBe(
			buildRestaurantOrderSessionIdempotencyKey({
				...base,
				orderId: 'ord_2',
			}),
		)
		expect(buildRestaurantOrderSessionIdempotencyKey(base)).not.toBe(
			buildRestaurantOrderSessionIdempotencyKey({
				...base,
				amountCents: 4251,
			}),
		)
		expect(buildRestaurantOrderSessionIdempotencyKey(base)).not.toBe(
			buildRestaurantOrderSessionIdempotencyKey({
				...base,
				currency: 'SAR',
			}),
		)
		expect(buildRestaurantOrderSessionIdempotencyKey(base)).not.toBe(
			buildRestaurantOrderSessionIdempotencyKey({
				...base,
				holdExpiresAt: null,
			}),
		)
	})

	it('is case-insensitive on currency', () => {
		const base = {
			orgId: 'org_1',
			orderId: 'ord_1',
			amountCents: 4250,
			holdExpiresAt: null as string | null,
		}
		expect(
			buildRestaurantOrderSessionIdempotencyKey({ ...base, currency: 'usd' }),
		).toBe(
			buildRestaurantOrderSessionIdempotencyKey({ ...base, currency: 'USD' }),
		)
	})
})

describe('mapConnectSessionToRestaurantOrder', () => {
	it('maps a paid session', () => {
		expect(
			mapConnectSessionToRestaurantOrder(
				stripeSession({ status: 'complete', payment_status: 'paid' }),
			),
		).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_test_123',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('maps an expired session', () => {
		expect(
			mapConnectSessionToRestaurantOrder(stripeSession({ status: 'expired' }))
				?.status,
		).toBe('expired')
	})

	it('maps async failures as failed', () => {
		expect(
			mapConnectSessionToRestaurantOrder(stripeSession(), { failed: true })
				?.status,
		).toBe('failed')
	})

	it('maps open unpaid sessions as pending (not terminal)', () => {
		const event = mapConnectSessionToRestaurantOrder(stripeSession())
		expect(event?.status).toBe('pending')
		expect(isTerminalRestaurantPaymentStatus(event!.status)).toBe(false)
	})

	it('returns null for shop or missing metadata', () => {
		expect(
			mapConnectSessionToRestaurantOrder(
				stripeSession({ metadata: { type: 'shop_order' } }),
			),
		).toBeNull()
		expect(
			mapConnectSessionToRestaurantOrder(stripeSession({ metadata: null })),
		).toBeNull()
		expect(
			mapConnectSessionToRestaurantOrder(
				stripeSession({ metadata: { type: RESTAURANT_ORDER_METADATA_TYPE } }),
			),
		).toBeNull()
		expect(
			mapConnectSessionToRestaurantOrder(stripeSession({ amount_total: null })),
		).toBeNull()
	})

	it('normalizes currency to lowercase and keeps provider amounts', () => {
		const event = mapConnectSessionToRestaurantOrder(
			stripeSession({ currency: 'SAR', amount_total: 15000 }),
		)
		expect(event).toMatchObject({
			status: 'pending',
			amountCents: 15000,
			currency: 'sar',
		})
	})
})

describe('mapCheckoutWebhookToRestaurantOrder', () => {
	const reference = 'restaurant_order:org_1:ord_1'
	const metadata = {
		type: RESTAURANT_ORDER_METADATA_TYPE,
		orgId: 'org_1',
		orderId: 'ord_1',
	}

	it('maps an approved payment, binding on the merchant reference', () => {
		expect(
			mapCheckoutWebhookToRestaurantOrder({
				type: 'payment_approved',
				data: {
					id: 'pay_1',
					amount: 4250,
					currency: 'USD',
					approved: true,
					reference,
					metadata,
				},
			}),
		).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: reference,
			processor: 'checkout',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
			// Tells two payments on one reference apart (QR tabs).
			paymentId: 'pay_1',
		})
	})

	it('does not depend on processing.payment_session_id (HPP payments may not carry it)', () => {
		const withSession = mapCheckoutWebhookToRestaurantOrder({
			type: 'payment_approved',
			data: {
				id: 'pay_1',
				amount: 4250,
				currency: 'USD',
				approved: true,
				reference,
				metadata,
				processing: { payment_session_id: 'hpp_1' },
			},
		})
		expect(withSession?.sessionId).toBe(reference)
	})

	it('maps declined payments as failed', () => {
		expect(
			mapCheckoutWebhookToRestaurantOrder({
				type: 'payment_declined',
				data: {
					id: 'pay_1',
					amount: 4250,
					currency: 'USD',
					status: 'Declined',
					reference,
					metadata,
				},
			})?.status,
		).toBe('failed')
	})

	it('skips pending events', () => {
		const event = mapCheckoutWebhookToRestaurantOrder({
			type: 'payment_pending',
			data: { id: 'pay_1', amount: 4250, currency: 'USD', reference, metadata },
		})
		expect(event?.status).toBe('pending')
		expect(isTerminalRestaurantPaymentStatus(event!.status)).toBe(false)
	})

	it('returns null when the reference does not match the order in the metadata', () => {
		for (const wrong of [undefined, 'restaurant_order:org_1:ord_2', 'other']) {
			expect(
				mapCheckoutWebhookToRestaurantOrder({
					type: 'payment_approved',
					data: {
						id: 'pay_1',
						amount: 4250,
						currency: 'USD',
						approved: true,
						reference: wrong,
						metadata,
						processing: { payment_session_id: 's_1' },
					},
				}),
			).toBeNull()
		}
	})

	it('returns null for shop orders and irrelevant events', () => {
		expect(
			mapCheckoutWebhookToRestaurantOrder({
				type: 'payment_approved',
				data: {
					id: 'pay_1',
					amount: 1999,
					currency: 'USD',
					approved: true,
					metadata: { type: 'shop_order', orgId: 'org_1' },
					processing: { payment_session_id: 's_1' },
				},
			}),
		).toBeNull()
		expect(
			mapCheckoutWebhookToRestaurantOrder({
				type: 'payment_refunded',
				data: {},
			}),
		).toBeNull()
	})
})

describe('mapCheckoutPaymentToRestaurantOrder', () => {
	const reference = restaurantOrderCheckoutReference('org_1', 'ord_1')
	const base = {
		id: 'pay_1',
		sessionId: null,
		reference,
		amountCents: 4250,
		currency: 'SAR',
		paid: false,
		metadata: {
			type: RESTAURANT_ORDER_METADATA_TYPE,
			orgId: 'org_1',
			orderId: 'ord_1',
		},
		productName: 'Restaurant order',
	}

	it('builds the reference the hosted page is created with', () => {
		expect(reference).toBe('restaurant_order:org_1:ord_1')
	})

	it('paid, declined and undecided payments', () => {
		expect(
			mapCheckoutPaymentToRestaurantOrder({ ...base, paid: true })?.status,
		).toBe('paid')
		expect(
			mapCheckoutPaymentToRestaurantOrder({ ...base, status: 'Declined' })
				?.status,
		).toBe('failed')
		expect(mapCheckoutPaymentToRestaurantOrder(base)?.status).toBe('pending')
		expect(
			mapCheckoutPaymentToRestaurantOrder({ ...base, paid: true }),
		).toMatchObject({
			sessionId: reference,
			currency: 'sar',
			processor: 'checkout',
		})
	})

	it('refuses a payment whose reference belongs to another order', () => {
		expect(
			mapCheckoutPaymentToRestaurantOrder({ ...base, reference: 'x' }),
		).toBeNull()
	})
})
