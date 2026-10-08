import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './webhook.tsx'

const WEBHOOK_SECRET = 'whsec_1234567890abcdef'

vi.hoisted(() => {
	// Literals only: this callback runs before top-level consts initialize.
	process.env.CHECKOUT_SECRET_KEY ??= 'sk_test_1234567890abcdef'
	process.env.CHECKOUT_PUBLIC_KEY ??= 'pk_test_1234567890abcdef'
	process.env.CHECKOUT_SUBDOMAIN ??= 'sandbox'
	process.env.CHECKOUT_PROCESSING_CHANNEL_ID ??= 'pc_test_1'
	process.env.CHECKOUT_WEBHOOK_SECRET ??= 'whsec_1234567890abcdef'
})

const restaurantDispatch = vi.hoisted(() => vi.fn())
const recordShopOrder = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/restaurant-orders/payment-webhooks.server.ts', () => ({
	handleRestaurantOrderCheckoutWebhookEvent: restaurantDispatch,
}))

vi.mock('#app/utils/shop.server.ts', () => ({
	recordShopOrder,
}))

function checkoutWebhookRequest(payload: string, signature: string) {
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

function signedCheckoutWebhookRequest(event: unknown) {
	const payload = JSON.stringify(event)
	const signature = createHmac('sha256', WEBHOOK_SECRET)
		.update(payload)
		.digest('hex')
	return checkoutWebhookRequest(payload, signature)
}

const RESTAURANT_EVENT = {
	type: 'payment_approved',
	data: {
		id: 'pay_1',
		amount: 4250,
		currency: 'USD',
		approved: true,
		metadata: {
			type: 'restaurant_order',
			orgId: 'org_1',
			orderId: 'ord_1',
		},
		processing: { payment_session_id: 's_1' },
	},
}

const SHOP_EVENT = {
	type: 'payment_approved',
	data: {
		id: 'pay_2',
		amount: 1999,
		currency: 'USD',
		approved: true,
		metadata: { type: 'shop_order', orgId: 'org_1', productName: 'Pack' },
		processing: { payment_session_id: 's_2' },
	},
}

describe('checkout.com webhook restaurant order dispatch', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		restaurantDispatch.mockReset().mockResolvedValue(undefined)
		recordShopOrder.mockReset().mockResolvedValue(undefined)
	})

	it('rejects forged signatures without dispatching anything', async () => {
		const response = await checkoutWebhookRequest(
			JSON.stringify(RESTAURANT_EVENT),
			'forged',
		)
		expect(response.status).toBe(400)
		expect(restaurantDispatch).not.toHaveBeenCalled()
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it('dispatches verified restaurant payments regionally, not into shop orders', async () => {
		const response = await signedCheckoutWebhookRequest(RESTAURANT_EVENT)
		expect(response.status).toBe(200)
		expect(restaurantDispatch).toHaveBeenCalledWith(RESTAURANT_EVENT)
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it('returns non-2xx when the regional callback fails so Checkout.com retries', async () => {
		restaurantDispatch.mockRejectedValue(
			new Error('regional tenant API unreachable'),
		)
		const response = await signedCheckoutWebhookRequest(RESTAURANT_EVENT)
		expect(response.status).toBe(500)
	})

	it('still records shop orders through the existing path', async () => {
		const response = await signedCheckoutWebhookRequest(SHOP_EVENT)
		expect(response.status).toBe(200)
		// The route passes every verified event to the restaurant dispatcher
		// (which itself ignores non-restaurant metadata — covered by its unit
		// tests), then falls through to the shop order recording path.
		expect(restaurantDispatch).toHaveBeenCalledWith(SHOP_EVENT)
		expect(recordShopOrder).toHaveBeenCalled()
	})
})
