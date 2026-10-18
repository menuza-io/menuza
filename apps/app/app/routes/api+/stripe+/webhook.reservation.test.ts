import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './webhook.tsx'

const constructEvent = vi.hoisted(() => vi.fn())
const reservation = vi.hoisted(() => ({
	session: vi.fn(),
	refund: vi.fn(),
	dispute: vi.fn(),
}))
const restaurantDispatch = vi.hoisted(() => vi.fn())
const recordShopOrder = vi.hoisted(() => vi.fn())

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
vi.mock('#app/utils/reservations/payment-webhooks.server.ts', () => ({
	handleReservationStripeSessionEvent: reservation.session,
	handleReservationStripeRefundEvent: reservation.refund,
	handleReservationStripeDisputeEvent: reservation.dispute,
	isReservationStripeMetadata: (metadata: Record<string, string> | null) =>
		metadata?.type?.startsWith('reservation_') ?? false,
}))
vi.mock('#app/utils/shop.server.ts', () => ({
	handleConnectAccountUpdated: vi.fn(),
	recordShopOrderFromConnectWebhook: recordShopOrder,
}))

function post(event: { id: string; type: string; data: { object: unknown } }) {
	return action({
		request: new Request('http://localhost:3001/api/stripe/webhook', {
			method: 'POST',
			headers: { 'stripe-signature': 't=1,v1=sig' },
			body: JSON.stringify(event),
		}),
		params: {},
		context: {},
	} as never) as Promise<Response>
}

const RESERVATION_SESSION = {
	id: 'cs_r1',
	status: 'complete',
	payment_status: 'paid',
	amount_total: 3333,
	currency: 'usd',
	metadata: {
		type: 'reservation_payment',
		orgId: 'org_1',
		reservationId: 'rsv_1',
		purpose: 'deposit',
	},
}

function verified(type: string, object: unknown) {
	const event = { id: 'evt_1', type, data: { object } }
	constructEvent.mockReturnValue(event)
	return event
}

describe('stripe webhook reservation dispatch', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		constructEvent.mockReset()
		for (const fn of Object.values(reservation)) {
			fn.mockReset().mockResolvedValue(undefined)
		}
		restaurantDispatch.mockReset().mockResolvedValue(undefined)
		recordShopOrder.mockReset().mockResolvedValue(undefined)
	})

	it('rejects forged signatures without dispatching anything', async () => {
		constructEvent.mockImplementation(() => {
			throw new Error('Webhook signature verification failed')
		})
		const response = await post({
			id: 'evt_1',
			type: 'checkout.session.completed',
			data: { object: RESERVATION_SESSION },
		})
		expect(response.status).toBe(400)
		for (const fn of Object.values(reservation))
			expect(fn).not.toHaveBeenCalled()
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it.each([
		'checkout.session.completed',
		'checkout.session.expired',
		'checkout.session.async_payment_succeeded',
		'checkout.session.async_payment_failed',
	])(
		'%s with reservation metadata goes to the reservation handler only',
		async (type) => {
			verified(type, RESERVATION_SESSION)
			const response = await post({
				id: 'evt_1',
				type,
				data: { object: RESERVATION_SESSION },
			})
			expect(response.status).toBe(200)
			expect(reservation.session).toHaveBeenCalledWith(
				RESERVATION_SESSION,
				type,
			)
			expect(restaurantDispatch).not.toHaveBeenCalled()
			expect(recordShopOrder).not.toHaveBeenCalled()
		},
	)

	it('keeps the order and shop behavior untouched', async () => {
		const order = {
			id: 'cs_o',
			metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'o1' },
		}
		verified('checkout.session.completed', order)
		await post({
			id: 'evt',
			type: 'checkout.session.completed',
			data: { object: order },
		})
		expect(restaurantDispatch).toHaveBeenCalled()
		expect(reservation.session).not.toHaveBeenCalled()
		const shop = {
			id: 'cs_s',
			metadata: { type: 'shop_order', orgId: 'org_1' },
		}
		verified('checkout.session.completed', shop)
		await post({
			id: 'evt',
			type: 'checkout.session.completed',
			data: { object: shop },
		})
		expect(recordShopOrder).toHaveBeenCalledTimes(1)
	})

	it('a reservation payment intent event is not recorded as a shop order', async () => {
		const intent = { id: 'pi_1', metadata: RESERVATION_SESSION.metadata }
		verified('payment_intent.succeeded', intent)
		const response = await post({
			id: 'evt',
			type: 'payment_intent.succeeded',
			data: { object: intent },
		})
		expect(response.status).toBe(200)
		expect(recordShopOrder).not.toHaveBeenCalled()
	})

	it.each(['refund.updated', 'refund.failed', 'charge.refund.updated'])(
		'%s goes to the refund handler',
		async (type) => {
			const refund = { id: 're_1', status: 'succeeded' }
			verified(type, refund)
			const response = await post({ id: 'evt', type, data: { object: refund } })
			expect(response.status).toBe(200)
			expect(reservation.refund).toHaveBeenCalledWith(refund)
		},
	)

	it.each(['charge.dispute.created', 'charge.dispute.closed'])(
		'%s goes to the dispute handler with its type',
		async (type) => {
			const dispute = { id: 'dp_1', payment_intent: 'pi_1' }
			verified(type, dispute)
			const response = await post({
				id: 'evt',
				type,
				data: { object: dispute },
			})
			expect(response.status).toBe(200)
			expect(reservation.dispute).toHaveBeenCalledWith(dispute, type)
		},
	)

	it('returns 500 when delivery to the region fails so Stripe retries', async () => {
		verified('checkout.session.completed', RESERVATION_SESSION)
		reservation.session.mockRejectedValue(new Error('regional unreachable'))
		const response = await post({
			id: 'evt',
			type: 'checkout.session.completed',
			data: { object: RESERVATION_SESSION },
		})
		expect(response.status).toBe(500)
		reservation.refund.mockRejectedValue(new Error('regional unreachable'))
		verified('refund.updated', { id: 're_1' })
		expect(
			(
				await post({
					id: 'evt',
					type: 'refund.updated',
					data: { object: { id: 're_1' } },
				})
			).status,
		).toBe(500)
	})
})
