import { describe, expect, it, vi } from 'vitest'
import { forwardPaymentReference } from './payment-reference.server.ts'

vi.mock('~/lib/worker-env', () => ({
	getAppServiceBinding: () => null,
	getPublicAppUrl: () => 'https://app.example',
}))

const reference = {
	slug: 'cafe',
	orderId: 'order',
	paymentToken: 'opaque-payment-token-long',
	locale: 'en',
}
const request = (body: unknown, origin = 'https://cafe.example') =>
	new Request('https://cafe.example/api/orders/payment', {
		method: 'POST',
		headers: { Origin: origin, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('opaque payment reference boundary', () => {
	it('rejects all contact, cart, and receipt fields before calling App', async () => {
		for (const extra of [
			{ contact: { name: 'Test' } },
			{ receiptToken: 'secret' },
			{ lines: [] },
		]) {
			const send = vi.fn()
			expect(
				(
					await forwardPaymentReference(
						request({ ...reference, ...extra }),
						'checkout',
						send,
					)
				).status,
			).toBe(400)
			expect(send).not.toHaveBeenCalled()
		}
	})
	it('rejects cross-origin submissions', async () => {
		const send = vi.fn()
		expect(
			(
				await forwardPaymentReference(
					request(reference, 'https://other.example'),
					'checkout',
					send,
				)
			).status,
		).toBe(403)
		expect(send).not.toHaveBeenCalled()
	})
	it('forwards only payment references and strips unexpected response fields', async () => {
		const send = vi.fn().mockResolvedValue(
			Response.json({
				checkoutUrl: 'https://pay.example/session',
				sessionId: 'session',
				processor: 'connect',
				customerEmail: 'should-not-pass@example.test',
			}),
		)
		const response = await forwardPaymentReference(
			request(reference),
			'checkout',
			send,
		)
		expect(JSON.parse(send.mock.calls[0]?.[1]?.body)).toEqual(reference)
		expect(await response.json()).toEqual({
			checkoutUrl: 'https://pay.example/session',
			sessionId: 'session',
			processor: 'connect',
		})
	})
	it('maps the App payment status payload for polling clients', async () => {
		const send = vi.fn().mockResolvedValue(
			Response.json({
				paymentStatus: 'paid',
				orderStatus: 'accepted',
				holdExpiresAt: null,
				processor: 'connect',
				customerEmail: 'should-not-pass@example.test',
			}),
		)
		const response = await forwardPaymentReference(
			request(reference),
			'status',
			send,
		)
		expect(await response.json()).toEqual({
			status: 'paid',
			orderStatus: 'accepted',
			holdExpiresAt: null,
		})
	})
})
