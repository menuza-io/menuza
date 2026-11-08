import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	checkoutPaymentStatusToOrderStatus,
	mapCheckoutWebhookToPayment,
	verifyCheckoutWebhookEvent,
} from './checkout-shop'

describe('checkoutPaymentStatusToOrderStatus', () => {
	it('a refunded or voided payment is not paid, though it was approved', () => {
		expect(checkoutPaymentStatusToOrderStatus(true, 'Refunded')).toBe(
			'refunded',
		)
		expect(checkoutPaymentStatusToOrderStatus(true, 'Voided')).toBe('failed')
		expect(checkoutPaymentStatusToOrderStatus(true, 'Partially Refunded')).toBe(
			'paid',
		)
	})

	it('maps approved payments to paid', () => {
		expect(checkoutPaymentStatusToOrderStatus(true)).toBe('paid')
		expect(checkoutPaymentStatusToOrderStatus(false, 'Declined')).toBe('failed')
		expect(checkoutPaymentStatusToOrderStatus(false, 'Pending')).toBe('pending')
	})
})

describe('mapCheckoutWebhookToPayment', () => {
	it('maps payment_approved events with metadata', () => {
		expect(
			mapCheckoutWebhookToPayment({
				type: 'payment_approved',
				data: {
					id: 'pay_1',
					amount: 1999,
					currency: 'USD',
					metadata: {
						type: 'shop_order',
						orgId: 'org_1',
						productName: 'Pack',
					},
					processing: {
						payment_session_id: 'ps_1',
					},
				},
			}),
		).toEqual({
			id: 'pay_1',
			sessionId: 'ps_1',
			reference: null,
			amountCents: 1999,
			currency: 'usd',
			paid: true,
			metadata: {
				type: 'shop_order',
				orgId: 'org_1',
				productName: 'Pack',
			},
			productName: 'Pack',
		})
	})
})

describe('mapCheckoutWebhookToPayment on adjustment events', () => {
	const refundAction = {
		id: 'pay_1',
		action_id: 'act_refund_1',
		// A partial refund: the action is approved, the payment is not
		// refunded in full.
		amount: 500,
		approved: true,
		currency: 'USD',
		metadata: { type: 'shop_order', orgId: 'org_1', productName: 'Pack' },
	}

	it('does not turn a (partial) refund event into a refunded payment', () => {
		const payment = mapCheckoutWebhookToPayment({
			type: 'payment_refunded',
			data: refundAction,
		})
		expect(payment).not.toBeNull()
		expect(payment!.status).toBeUndefined()
		expect(
			checkoutPaymentStatusToOrderStatus(payment!.paid, payment!.status),
		).not.toBe('refunded')
	})

	it('does not invent a status for a canceled or expired payment', () => {
		for (const type of [
			'payment_canceled',
			'payment_expired',
			'payment_voided',
		]) {
			const payment = mapCheckoutWebhookToPayment({
				type,
				data: { id: 'pay_1', approved: true },
			})
			expect({ type, status: payment?.status }).toEqual({
				type,
				status: undefined,
			})
		}
		expect(
			mapCheckoutWebhookToPayment({
				type: 'payment_expired',
				data: { id: 'pay_1', status: 'Expired' },
			})?.status,
		).toBe('Expired')
	})
})

describe('verifyCheckoutWebhookEvent', () => {
	it('verifies HMAC signatures on the raw payload', () => {
		const payload = JSON.stringify({
			type: 'payment_approved',
			data: { id: 'pay_1' },
		})
		const secret = 'whsec_test'
		const signature = createHmac('sha256', secret).update(payload).digest('hex')

		expect(verifyCheckoutWebhookEvent(payload, signature, secret)).toEqual({
			type: 'payment_approved',
			data: { id: 'pay_1' },
		})
	})
})
