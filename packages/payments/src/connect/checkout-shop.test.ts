import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	checkoutPaymentStatusToOrderStatus,
	mapCheckoutWebhookToPayment,
	verifyCheckoutWebhookEvent,
} from './checkout-shop'

describe('checkoutPaymentStatusToOrderStatus', () => {
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
