import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './webhook.tsx'

const constructEvent = vi.hoisted(() => vi.fn())
const restaurantDispatch = vi.hoisted(() => vi.fn())
const recordShopOrder = vi.hoisted(() => vi.fn())
const accountUpdated = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/payments.server.ts', () => ({
	stripe: { webhooks: { constructEvent } },
	handleSubscriptionChange: vi.fn(),
	handleTrialEnd: vi.fn(),
}))

vi.mock('#app/utils/restaurant-orders/payment-webhooks.server.ts', () => ({
	handleRestaurantOrderStripeSessionEvent: restaurantDispatch,
	isRestaurantStripeMetadata: (metadata: Record<string, string> | null) =>
		metadata?.type === 'restaurant_order',
}))

vi.mock('#app/utils/shop.server.ts', () => ({
	handleConnectAccountUpdated: accountUpdated,
	recordShopOrderFromConnectWebhook: recordShopOrder,
}))

function postEvent(event: {
	id: string
	type: string
	data: { object: unknown }
}) {
	return action({
		request: new Request('http://localhost:3001/api/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': 't=1,v1=forged' },
			body: JSON.stringify(event),
		}),
		params: {},
		context: {},
	} as never) as Promise<Response>
}

const RESTAURANT_SESSION = {
	id: 'cs_1',
	status: 'complete',
	payment_status: 'paid',
	amount_total: 4250,
	currency: 'usd',
	metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'ord_1' },
}

const SHOP_SESSION = {
	id: 'cs_2',
	status: 'complete',
	payment_status: 'paid',
	amount_total: 1999,
	currency: 'usd',
	metadata: { type: 'shop_order', orgId: 'org_1' },
}

describe('stripe webhook restaurant order dispatch', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		constructEvent.mockReset()
		restaurantDispatch.mockReset().mockResolvedValue(undefined)
		recordShopOrder.mockReset().mockResolvedValue(undefined)
		accountUpdated.mockReset().mockResolvedValue(undefined)
	})

	it('rejects forged signatures without dispatching anything', async () => {
		constructEvent.mockImplementation(() => {
			throw new Error('Webhook signature verification failed')
		})
		const response = await postEvent({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESTAURANT_SESSION },
		})
		expect(response.status).toBe(400)
		expect(restaurantDispatch).not.toHaveBeenCalled()
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it('dispatches restaurant sessions regionally instead of recording shop orders', async () => {
		constructEvent.mockReturnValue({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESTAURANT_SESSION },
		})
		const response = await postEvent({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESTAURANT_SESSION },
		})
		expect(response.status).toBe(200)
		expect(restaurantDispatch).toHaveBeenCalledWith(
			RESTAURANT_SESSION,
			'checkout.session.completed',
		)
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it('returns non-2xx when the regional callback fails so Stripe retries', async () => {
		constructEvent.mockReturnValue({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESTAURANT_SESSION },
		})
		restaurantDispatch.mockRejectedValue(
			new Error('regional tenant API unreachable'),
		)
		const response = await postEvent({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESTAURANT_SESSION },
		})
		expect(response.status).toBe(500)
	})

	it('still records shop orders through the existing path', async () => {
		constructEvent.mockReturnValue({
			id: 'evt_2',
			type: 'checkout.session.completed',
			data: { object: SHOP_SESSION },
		})
		const response = await postEvent({
			id: 'evt_2',
			type: 'checkout.session.completed',
			data: { object: SHOP_SESSION },
		})
		expect(response.status).toBe(200)
		expect(restaurantDispatch).not.toHaveBeenCalled()
		expect(recordShopOrder).toHaveBeenCalledWith(
			SHOP_SESSION,
			'checkout.session.completed',
		)
	})

	it('ignores restaurant payment intents (session events are authoritative)', async () => {
		const paymentIntent = {
			id: 'pi_1',
			status: 'succeeded',
			amount: 4250,
			currency: 'usd',
			metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'ord_1' },
		}
		constructEvent.mockReturnValue({
			id: 'evt_3',
			type: 'payment_intent.succeeded',
			data: { object: paymentIntent },
		})
		const response = await postEvent({
			id: 'evt_3',
			type: 'payment_intent.succeeded',
			data: { object: paymentIntent },
		})
		expect(response.status).toBe(200)
		expect(restaurantDispatch).not.toHaveBeenCalled()
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it('handles restaurant async and expired session events', async () => {
		for (const type of [
			'checkout.session.async_payment_succeeded',
			'checkout.session.async_payment_failed',
			'checkout.session.expired',
		]) {
			constructEvent.mockReturnValue({
				id: 'evt_4',
				type,
				data: { object: RESTAURANT_SESSION },
			})
			const response = await postEvent({
				id: 'evt_4',
				type,
				data: { object: RESTAURANT_SESSION },
			})
			expect(response.status).toBe(200)
			expect(restaurantDispatch).toHaveBeenCalledWith(RESTAURANT_SESSION, type)
		}
		expect(recordShopOrder).not.toHaveBeenCalled()
	})
})
