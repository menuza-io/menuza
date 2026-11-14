import type * as DatabaseModule from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleTable, mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { consoleError, consoleWarn } from '#tests/setup/setup-test-env.ts'
import {
	handleRestaurantOrderCheckoutRefundOrDisputeEvent,
	handleRestaurantOrderCheckoutWebhookEvent,
	handleRestaurantOrderStripeDisputeEvent,
	handleRestaurantOrderStripeRefundEvent,
	handleRestaurantOrderStripeSessionEvent,
	isRestaurantStripeRefund,
} from './payment-webhooks.server.ts'
import type * as RegionalOrderApiModule from './regional-order-api.server.ts'
import { RegionalOrderApiError } from './regional-order-api.server.ts'

const findOrg = vi.hoisted(() => vi.fn())
const notify = vi.hoisted(() => vi.fn())
const reportRefund = vi.hoisted(() => vi.fn())
const reportDispute = vi.hoisted(() => vi.fn())
const commerce = vi.hoisted(() => ({
	retrieveReservationPaymentIntent: vi.fn(),
	listReservationCheckoutPaymentActions: vi.fn(),
	retrieveReservationCheckoutPayment: vi.fn(),
}))

vi.mock('#app/utils/shop.server.ts', () => ({
	getShopCommerce: () => commerce,
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		and: (...args: unknown[]) => args,
		eq: (...args: unknown[]) => args,
	}
})

vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalOrderApiModule>()
		return {
			...actual,
			notifyRestaurantOrderPaymentStatus: notify,
			reportRestaurantOrderRefundStatus: reportRefund,
			reportRestaurantOrderDisputeStatus: reportDispute,
		}
	},
)

function stripeSession(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'cs_1',
		status: 'complete',
		payment_status: 'paid',
		amount_total: 4250,
		currency: 'usd',
		metadata: {
			type: 'restaurant_order',
			orgId: 'org_1',
			orderId: 'ord_1',
		},
		...overrides,
	}
}

describe('restaurant order webhook dispatch', () => {
	beforeEach(() => {
		resetMockDb()
		consoleError.mockImplementation(() => {})
		findOrg.mockReset().mockResolvedValue({ dataRegion: 'us' })
		notify.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('forwards verified terminal Stripe session events to the regional service', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession() as never,
			'checkout.session.completed',
		)

		expect(findOrg).toHaveBeenCalledWith(expect.anything())
		expect(notify).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('forwards the paid session’s PaymentIntent id for the region to keep', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ payment_intent: 'pi_1' }) as never,
			'checkout.session.completed',
		)
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				orderId: 'ord_1',
				sessionId: 'cs_1',
				status: 'paid',
				paymentId: 'pi_1',
			}),
		)
	})

	it('maps async failures as failed', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'open', payment_status: 'unpaid' }) as never,
			'checkout.session.async_payment_failed',
		)
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'failed' }),
		)
	})

	it('maps expired sessions as expired', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'expired', payment_status: 'unpaid' }) as never,
			'checkout.session.expired',
		)
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'expired' }),
		)
	})

	it('ignores non-restaurant and pending sessions', async () => {
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({
				metadata: { type: 'shop_order', orgId: 'org_1' },
			}) as never,
			'checkout.session.completed',
		)
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession({ status: 'open', payment_status: 'unpaid' }) as never,
			'checkout.session.completed',
		)
		expect(notify).not.toHaveBeenCalled()
	})

	it('throws on transient regional failures so the webhook retries', async () => {
		notify.mockRejectedValue(
			new RegionalOrderApiError('regional_unreachable', 503),
		)
		await expect(
			handleRestaurantOrderStripeSessionEvent(
				stripeSession() as never,
				'checkout.session.completed',
			),
		).rejects.toMatchObject({ code: 'regional_unreachable' })
	})

	it('acknowledges permanent regional rejections without confirming', async () => {
		// e.g. session/amount mismatch: the regional service refuses to record.
		notify.mockRejectedValue(new RegionalOrderApiError('session_mismatch', 409))
		await expect(
			handleRestaurantOrderStripeSessionEvent(
				stripeSession() as never,
				'checkout.session.completed',
			),
		).resolves.toBeUndefined()
	})

	it('ignores events for unknown or inactive organizations', async () => {
		findOrg.mockResolvedValue(null)
		consoleWarn.mockImplementation(() => {})
		await handleRestaurantOrderStripeSessionEvent(
			stripeSession() as never,
			'checkout.session.completed',
		)
		expect(notify).not.toHaveBeenCalled()
	})

	it('forwards verified Checkout.com terminal payments bound on the merchant reference', async () => {
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_approved',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				approved: true,
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
				reference: 'restaurant_order:org_1:ord_1',
			},
		})

		expect(notify).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'restaurant_order:org_1:ord_1',
			processor: 'checkout',
			status: 'paid',
			amountCents: 15000,
			currency: 'sar',
			paymentId: 'pay_1',
		})
	})

	it('ignores Checkout.com events whose reference does not match the order', async () => {
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_approved',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				approved: true,
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
			},
		})
		expect(notify).not.toHaveBeenCalled()
	})

	it('routes KSA org events to the KSA region', async () => {
		findOrg.mockResolvedValue({ dataRegion: 'ksa' })
		await handleRestaurantOrderCheckoutWebhookEvent({
			type: 'payment_declined',
			data: {
				id: 'pay_1',
				amount: 15000,
				currency: 'SAR',
				status: 'Declined',
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_1',
					orderId: 'ord_1',
				},
				reference: 'restaurant_order:org_1:ord_1',
			},
		})
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				dataRegion: 'ksa',
				status: 'failed',
			}),
		)
	})
})

describe('restaurant order refund and dispute webhooks (#80)', () => {
	const REFUND = {
		id: 're_1',
		object: 'refund',
		amount: 1000,
		currency: 'usd',
		status: 'succeeded',
		payment_intent: 'pi_1',
		failure_reason: null,
		metadata: {
			type: 'restaurant_order',
			orgId: 'org_1',
			orderId: 'ord_1',
			refundId: 'rf_1',
		},
	}

	beforeEach(() => {
		resetMockDb()
		consoleError.mockImplementation(() => {})
		consoleWarn.mockImplementation(() => {})
		findOrg.mockReset().mockResolvedValue({ dataRegion: 'us' })
		reportRefund.mockReset().mockResolvedValue({ applied: true })
		reportDispute.mockReset().mockResolvedValue(undefined)
		for (const fn of Object.values(commerce)) fn.mockReset()
	})

	it('forwards ids, amount and currency of a settled refund, nothing else', async () => {
		await handleRestaurantOrderStripeRefundEvent(REFUND as never)
		expect(reportRefund).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			refundId: 'rf_1',
			providerRefundId: 're_1',
			processor: 'connect',
			status: 'succeeded',
			amountCents: 1000,
			currency: 'USD',
		})
	})

	it('reports a failed refund with its short reason; a pending one adds nothing', async () => {
		await handleRestaurantOrderStripeRefundEvent({
			...REFUND,
			status: 'failed',
			failure_reason: 'lost_or_stolen_card',
		} as never)
		expect(reportRefund).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				failureCode: 'lost_or_stolen_card',
			}),
		)
		reportRefund.mockClear()
		await handleRestaurantOrderStripeRefundEvent({
			...REFUND,
			status: 'pending',
		} as never)
		expect(reportRefund).not.toHaveBeenCalled()
	})

	it('forwards a refund Stripe fails after it succeeded, for the region to reverse', async () => {
		await handleRestaurantOrderStripeRefundEvent(REFUND as never)
		expect(reportRefund).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: 'succeeded' }),
		)
		// `refund.failed` / `refund.updated` later on the same refund.
		await handleRestaurantOrderStripeRefundEvent({
			...REFUND,
			status: 'failed',
			failure_reason: 'expired_or_canceled_card',
		} as never)
		expect(reportRefund).toHaveBeenCalledTimes(2)
		expect(reportRefund).toHaveBeenLastCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			refundId: 'rf_1',
			providerRefundId: 're_1',
			processor: 'connect',
			status: 'failed',
			failureCode: 'expired_or_canceled_card',
			amountCents: 1000,
			currency: 'USD',
		})
	})

	it('ignores refunds of anything else (reservations, the shop, a refund made outside Menuza)', async () => {
		for (const metadata of [
			{ type: 'reservation_refund', orgId: 'org_1', refundRequestId: 'rr_1' },
			{ type: 'shop_order', orgId: 'org_1' },
			{ type: 'restaurant_order', orgId: 'org_1', orderId: 'ord_1' },
			{},
		]) {
			expect(isRestaurantStripeRefund({ metadata } as never)).toBe(false)
			await handleRestaurantOrderStripeRefundEvent({
				...REFUND,
				metadata,
			} as never)
		}
		expect(reportRefund).not.toHaveBeenCalled()
		expect(isRestaurantStripeRefund(REFUND as never)).toBe(true)
	})

	it('acknowledges a refund the region does not know (an older region answers 404) or already settled', async () => {
		for (const [code, status] of [
			['http_404', 404],
			['refund_complete', 409],
			['refund_mismatch', 422],
		] as const) {
			reportRefund.mockRejectedValueOnce(
				new RegionalOrderApiError(code, status),
			)
			await expect(
				handleRestaurantOrderStripeRefundEvent(REFUND as never),
			).resolves.toBeUndefined()
		}
	})

	it('throws on transient and wiring failures so the provider redelivers', async () => {
		for (const [code, status] of [
			['regional_unreachable', 503],
			['Unauthorized', 401],
			['invalid_request', 400],
		] as const) {
			reportRefund.mockRejectedValueOnce(
				new RegionalOrderApiError(code, status),
			)
			await expect(
				handleRestaurantOrderStripeRefundEvent(REFUND as never),
			).rejects.toMatchObject({ code })
		}
	})

	it('maps Stripe disputes by the payment intent’s order metadata', async () => {
		commerce.retrieveReservationPaymentIntent.mockResolvedValue({
			id: 'pi_1',
			metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'tab:t1' },
		})
		await handleRestaurantOrderStripeDisputeEvent(
			{ id: 'dp_1', payment_intent: 'pi_1', status: 'needs_response' } as never,
			'charge.dispute.created',
		)
		await handleRestaurantOrderStripeDisputeEvent(
			{ id: 'dp_1', payment_intent: 'pi_1', status: 'won' } as never,
			'charge.dispute.closed',
		)
		expect(reportDispute.mock.calls.map(([input]) => input)).toEqual([
			{
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'tab:t1',
				processor: 'connect',
				status: 'open',
			},
			{
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'tab:t1',
				processor: 'connect',
				status: 'won',
			},
		])
	})

	it('does not report a Stripe inquiry, which never blocks a refund; its escalation does', async () => {
		commerce.retrieveReservationPaymentIntent.mockResolvedValue({
			id: 'pi_1',
			metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'ord_1' },
		})
		for (const [status, event] of [
			['warning_needs_response', 'charge.dispute.created'],
			['warning_under_review', 'charge.dispute.updated'],
			['warning_closed', 'charge.dispute.closed'],
		] as const) {
			await handleRestaurantOrderStripeDisputeEvent(
				{ id: 'dp_1', payment_intent: 'pi_1', status } as never,
				event,
			)
		}
		expect(reportDispute).not.toHaveBeenCalled()
		await handleRestaurantOrderStripeDisputeEvent(
			{ id: 'dp_1', payment_intent: 'pi_1', status: 'needs_response' } as never,
			'charge.dispute.updated',
		)
		expect(reportDispute).toHaveBeenCalledTimes(1)
		expect(reportDispute.mock.calls[0]![0]).toMatchObject({ status: 'open' })
	})

	it('ignores disputes of other payments and of payments it cannot find', async () => {
		commerce.retrieveReservationPaymentIntent.mockResolvedValueOnce({
			id: 'pi_2',
			metadata: { type: 'reservation_payment', orgId: 'org_1' },
		})
		await handleRestaurantOrderStripeDisputeEvent(
			{ id: 'dp_2', payment_intent: 'pi_2', status: 'lost' } as never,
			'charge.dispute.closed',
		)
		commerce.retrieveReservationPaymentIntent.mockRejectedValueOnce(
			Object.assign(new Error('missing'), { statusCode: 404 }),
		)
		await handleRestaurantOrderStripeDisputeEvent(
			{ id: 'dp_3', payment_intent: 'pi_3', status: 'lost' } as never,
			'charge.dispute.closed',
		)
		expect(reportDispute).not.toHaveBeenCalled()
	})

	const CKO_PAYMENT = {
		id: 'pay_1',
		action_id: 'act_1',
		amount: 15000,
		currency: 'SAR',
		approved: true,
		response_code: '10000',
		reference: 'restaurant_order:org_1:ord_1',
		metadata: { type: 'restaurant_order', orgId: 'org_1', orderId: 'ord_1' },
	}

	it('reads the refund id from the Checkout.com refund action and reports by both ids', async () => {
		commerce.listReservationCheckoutPaymentActions.mockResolvedValue([
			{ id: 'act_1', type: 'Refund', approved: true, reference: 'ror_rf_9' },
		])
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'payment_refunded',
			data: CKO_PAYMENT,
		})
		expect(reportRefund).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			refundId: 'rf_9',
			providerRefundId: 'act_1',
			processor: 'checkout',
			status: 'succeeded',
			amountCents: 15000,
			currency: 'SAR',
		})
		reportRefund.mockClear()
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'payment_refund_declined',
			data: { ...CKO_PAYMENT, approved: false },
		})
		expect(reportRefund).toHaveBeenCalledWith(
			expect.objectContaining({
				refundId: 'rf_9',
				status: 'failed',
				failureCode: 'refund_declined',
			}),
		)
	})

	it('reports by the action id alone when the action has no refund reference', async () => {
		commerce.listReservationCheckoutPaymentActions.mockResolvedValue([])
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'payment_refunded',
			data: CKO_PAYMENT,
		})
		expect(reportRefund.mock.calls[0]![0]).not.toHaveProperty('refundId')
		expect(reportRefund.mock.calls[0]![0]).toMatchObject({
			providerRefundId: 'act_1',
		})
	})

	it('maps Checkout.com disputes through the payment and ignores other payments', async () => {
		commerce.retrieveReservationCheckoutPayment.mockResolvedValueOnce({
			id: 'pay_1',
			metadata: CKO_PAYMENT.metadata,
		})
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'dispute_lost',
			data: { id: 'dsp_1', payment_id: 'pay_1' },
		})
		expect(reportDispute).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			processor: 'checkout',
			status: 'lost',
		})
		reportDispute.mockClear()
		commerce.retrieveReservationCheckoutPayment.mockResolvedValueOnce({
			id: 'pay_2',
			metadata: { type: 'reservation_payment', orgId: 'org_1' },
		})
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'dispute_received',
			data: { id: 'dsp_2', payment_id: 'pay_2' },
		})
		await handleRestaurantOrderCheckoutRefundOrDisputeEvent({
			type: 'payment_approved',
			data: CKO_PAYMENT,
		})
		expect(reportDispute).not.toHaveBeenCalled()
		expect(reportRefund).not.toHaveBeenCalled()
	})
})
