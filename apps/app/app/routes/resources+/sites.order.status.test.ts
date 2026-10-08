import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './sites.order.status.ts'

const getStatus = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/rate-limit.server.ts', () => ({
	RESTAURANT_ORDER_STATUS_RATE_LIMIT: {},
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
	createRateLimitResponse: vi.fn(
		() => new Response('rate limited', { status: 429 }),
	),
}))

vi.mock('@repo/security', () => ({
	getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('#app/utils/restaurant-orders/checkout.server.ts', () => ({
	getRestaurantOrderPaymentStatus: getStatus,
}))

function post(body: unknown) {
	return action({
		request: new Request('http://localhost:3001/resources/sites/order/status', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
		params: {},
		context: {},
	} as never) as Promise<Response>
}

describe('browser order payment status endpoint', () => {
	beforeEach(() => {
		getStatus.mockReset().mockResolvedValue({
			paymentStatus: 'pending',
			orderStatus: 'pending',
			holdExpiresAt: '2026-10-08T12:10:00.000Z',
			processor: null,
		})
	})

	it('reports payment status without PII and with no-store', async () => {
		const response = await post({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			paymentStatus: 'pending',
			orderStatus: 'pending',
			holdExpiresAt: '2026-10-08T12:10:00.000Z',
			processor: null,
		})
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(getStatus).toHaveBeenCalledWith({
			slug: 'cafe',
			host: undefined,
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
	})

	it('rejects extra fields, contact data, and unknown properties', async () => {
		for (const body of [
			{
				host: 'cafe.example.com',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
				receipt: 'anything',
			},
			{
				slug: 'cafe',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
				contact: { phone: '+1555' },
			},
			{ slug: 'cafe', orderId: 'ord_1' },
			{ orderId: 'ord_1', paymentToken: 'tok_1' },
		]) {
			expect((await post(body)).status).toBe(400)
		}
		expect(getStatus).not.toHaveBeenCalled()
	})

	it('propagates orchestrator error responses', async () => {
		getStatus.mockRejectedValue(
			Response.json(
				{ error: 'order_not_found', retryable: false },
				{ status: 404 },
			),
		)
		const response = await post({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		}).catch((error: unknown) => error as Response)
		expect(response.status).toBe(404)
	})
})
