import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './webhook.tsx'

const WEBHOOK_SECRET = 'whsec_1234567890abcdef'

vi.hoisted(() => {
	process.env.CHECKOUT_SECRET_KEY ??= 'sk_test_1234567890abcdef'
	process.env.CHECKOUT_PUBLIC_KEY ??= 'pk_test_1234567890abcdef'
	process.env.CHECKOUT_SUBDOMAIN ??= 'sandbox'
	process.env.CHECKOUT_PROCESSING_CHANNEL_ID ??= 'pc_test_1'
	process.env.CHECKOUT_WEBHOOK_SECRET ??= 'whsec_1234567890abcdef'
})

const reservationDispatch = vi.hoisted(() => vi.fn())
const restaurantDispatch = vi.hoisted(() => vi.fn())
const recordShopOrder = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/reservations/payment-webhooks.server.ts', () => ({
	handleReservationCheckoutWebhookEvent: reservationDispatch,
}))
vi.mock('#app/utils/restaurant-orders/payment-webhooks.server.ts', () => ({
	handleRestaurantOrderCheckoutWebhookEvent: restaurantDispatch,
}))
vi.mock('#app/utils/shop.server.ts', async () => {
	const { createShopCommerce, createShopCommerceConfigFromEnv } =
		await import('@repo/payments')
	const commerce = createShopCommerce(
		createShopCommerceConfigFromEnv(process.env),
	)
	return { recordShopOrder, getShopCommerce: () => commerce }
})

function post(payload: string, signature: string) {
	return action({
		request: new Request('http://localhost:3001/api/shop/webhook', {
			method: 'POST',
			headers: { 'cko-signature': signature },
			body: payload,
		}),
		params: {},
		context: {},
	} as never) as Promise<Response>
}

function signed(event: unknown) {
	const payload = JSON.stringify(event)
	return post(
		payload,
		createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
	)
}

const EVENT = {
	type: 'payment_approved',
	data: {
		id: 'pay_1',
		amount: 12000,
		currency: 'SAR',
		approved: true,
		reference: 'rsv_deposit_x',
		metadata: {
			type: 'reservation_payment',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit',
		},
	},
}

describe('checkout.com webhook reservation dispatch', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		reservationDispatch.mockReset().mockResolvedValue(undefined)
		restaurantDispatch.mockReset().mockResolvedValue(undefined)
		recordShopOrder.mockReset().mockResolvedValue(undefined)
	})

	it('rejects forged signatures (constant-time compare is unchanged) without dispatching', async () => {
		const response = await post(JSON.stringify(EVENT), 'forged')
		expect(response.status).toBe(400)
		expect(reservationDispatch).not.toHaveBeenCalled()
		expect(restaurantDispatch).not.toHaveBeenCalled()
	})

	it.each([
		'payment_approved',
		'payment_captured',
		'payment_declined',
		'payment_refunded',
		'payment_refund_declined',
		'dispute_received',
		'dispute_won',
		'dispute_lost',
	])('hands a verified %s to the reservation dispatcher', async (type) => {
		const event = { ...EVENT, type }
		const response = await signed(event)
		expect(response.status).toBe(200)
		expect(reservationDispatch).toHaveBeenCalledWith(event)
	})

	it('returns 500 when delivery to the region fails so Checkout.com retries', async () => {
		reservationDispatch.mockRejectedValue(new Error('regional unreachable'))
		expect((await signed(EVENT)).status).toBe(500)
	})

	it('leaves order and shop events to their own paths', async () => {
		const response = await signed({
			type: 'payment_approved',
			data: { id: 'pay_2', metadata: { type: 'shop_order', orgId: 'org_1' } },
		})
		expect(response.status).toBe(200)
		expect(restaurantDispatch).toHaveBeenCalled()
	})
})
