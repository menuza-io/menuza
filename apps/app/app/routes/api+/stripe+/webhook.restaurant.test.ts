import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './webhook.tsx'

const constructEvent = vi.hoisted(() => vi.fn())
const restaurantDispatch = vi.hoisted(() => vi.fn())
const recordShopOrder = vi.hoisted(() => vi.fn())
const accountUpdated = vi.hoisted(() => vi.fn())
const restaurantRefund = vi.hoisted(() => vi.fn())
const restaurantDispute = vi.hoisted(() => vi.fn())
const reservationRefund = vi.hoisted(() => vi.fn())
const reservationDispute = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/payments.server.ts', () => ({
	stripe: { webhooks: { constructEvent } },
	handleSubscriptionChange: vi.fn(),
	handleTrialEnd: vi.fn(),
}))

vi.mock('#app/utils/restaurant-orders/payment-webhooks.server.ts', () => ({
	handleRestaurantOrderStripeSessionEvent: restaurantDispatch,
	handleRestaurantOrderStripeRefundEvent: restaurantRefund,
	handleRestaurantOrderStripeDisputeEvent: restaurantDispute,
	isRestaurantStripeMetadata: (metadata: Record<string, string> | null) =>
		metadata?.type === 'restaurant_order',
	isRestaurantStripeRefund: (refund: { metadata?: Record<string, string> }) =>
		refund.metadata?.type === 'restaurant_order' &&
		Boolean(refund.metadata.refundId),
}))
vi.mock('#app/utils/reservations/payment-webhooks.server.ts', () => ({
	handleReservationStripeSessionEvent: vi.fn(),
	handleReservationStripeRefundEvent: reservationRefund,
	handleReservationStripeDisputeEvent: reservationDispute,
	isReservationStripeMetadata: (metadata: Record<string, string> | null) =>
		metadata?.type?.startsWith('reservation_') ?? false,
}))

vi.mock('#app/utils/shop.server.ts', () => ({
	handleConnectAccountUpdated: accountUpdated,
	recordShopOrderFromConnectWebhook: recordShopOrder,
	recordShopOrderAdjustmentFromConnectWebhook: vi.fn(),
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
		// The `.env.schema` placeholder (`whsec_***`) no longer counts as a secret.
		vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test_webhook_secret')
		consoleError.mockImplementation(() => {})
		constructEvent.mockReset()
		restaurantDispatch.mockReset().mockResolvedValue(undefined)
		recordShopOrder.mockReset().mockResolvedValue(undefined)
		accountUpdated.mockReset().mockResolvedValue(undefined)
		for (const fn of [
			restaurantRefund,
			restaurantDispute,
			reservationRefund,
			reservationDispute,
		]) {
			fn.mockReset().mockResolvedValue(undefined)
		}
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
			undefined,
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

	it('ignores sessions and payments from a connected account, whatever their metadata', async () => {
		for (const object of [RESTAURANT_SESSION, SHOP_SESSION]) {
			constructEvent.mockReturnValue({
				id: 'evt_5',
				type: 'checkout.session.completed',
				account: 'acct_attacker',
				data: { object },
			})
			const response = await postEvent({
				id: 'evt_5',
				type: 'checkout.session.completed',
				data: { object },
			})
			expect(response.status).toBe(200)
		}
		expect(restaurantDispatch).not.toHaveBeenCalled()
		expect(recordShopOrder).not.toHaveBeenCalled()

		// Account updates from connected accounts still count.
		constructEvent.mockReturnValue({
			id: 'evt_6',
			type: 'account.updated',
			account: 'acct_1',
			data: { object: { id: 'acct_1' } },
		})
		await postEvent({
			id: 'evt_6',
			type: 'account.updated',
			data: { object: { id: 'acct_1' } },
		})
		expect(accountUpdated).toHaveBeenCalled()
	})

	describe('refunds and disputes (#80)', () => {
		const RESTAURANT_REFUND = {
			id: 're_1',
			object: 'refund',
			amount: 1000,
			currency: 'usd',
			status: 'succeeded',
			payment_intent: 'pi_1',
			metadata: {
				type: 'restaurant_order',
				orgId: 'org_1',
				orderId: 'ord_1',
				refundId: 'rf_1',
			},
		}
		const RESERVATION_REFUND = {
			...RESTAURANT_REFUND,
			id: 're_2',
			metadata: {
				type: 'reservation_refund',
				orgId: 'org_1',
				reservationId: 'rsv_1',
				refundRequestId: 'rr_1',
			},
		}

		async function send(type: string, object: unknown, account?: string) {
			const event = { id: 'evt_r', type, data: { object }, account }
			constructEvent.mockReturnValue(event)
			return postEvent(event)
		}

		it('sends restaurant order refunds to the order handler and reservation refunds to theirs', async () => {
			for (const type of [
				'refund.updated',
				'refund.failed',
				'charge.refund.updated',
			]) {
				restaurantRefund.mockClear()
				reservationRefund.mockClear()
				expect((await send(type, RESTAURANT_REFUND)).status).toBe(200)
				expect(restaurantRefund).toHaveBeenCalledWith(RESTAURANT_REFUND)
				expect(reservationRefund).not.toHaveBeenCalled()

				restaurantRefund.mockClear()
				expect((await send(type, RESERVATION_REFUND)).status).toBe(200)
				expect(reservationRefund).toHaveBeenCalledWith(RESERVATION_REFUND)
				expect(restaurantRefund).not.toHaveBeenCalled()
			}
		})

		it('ignores a restaurant refund reported by a connected account', async () => {
			expect(
				(await send('refund.updated', RESTAURANT_REFUND, 'acct_x')).status,
			).toBe(200)
			expect(restaurantRefund).not.toHaveBeenCalled()
			expect(reservationRefund).not.toHaveBeenCalled()
		})

		it('gives every platform dispute to both handlers (each ignores the others)', async () => {
			const dispute = { id: 'dp_1', payment_intent: 'pi_1', status: 'lost' }
			for (const type of ['charge.dispute.created', 'charge.dispute.closed']) {
				restaurantDispute.mockClear()
				reservationDispute.mockClear()
				expect((await send(type, dispute)).status).toBe(200)
				expect(reservationDispute).toHaveBeenCalledWith(dispute, type)
				expect(restaurantDispute).toHaveBeenCalledWith(dispute, type)
			}
		})

		it('answers 500 when the region could not be reached, so Stripe retries', async () => {
			restaurantRefund.mockRejectedValue(new Error('regional_unreachable'))
			expect((await send('refund.updated', RESTAURANT_REFUND)).status).toBe(500)
		})
	})
})
