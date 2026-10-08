import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './sites.order.checkout.ts'

const createCheckout = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/rate-limit.server.ts', () => ({
	RESTAURANT_ORDER_CHECKOUT_RATE_LIMIT: {},
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
	createRateLimitResponse: vi.fn(
		() => new Response('rate limited', { status: 429 }),
	),
}))

vi.mock('@repo/security', () => ({
	getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('#app/utils/restaurant-orders/checkout.server.ts', () => ({
	createRestaurantOrderHostedCheckout: createCheckout,
}))

function post(body: unknown) {
	return action({
		request: new Request(
			'http://localhost:3001/resources/sites/order/checkout',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: typeof body === 'string' ? body : JSON.stringify(body),
			},
		),
		params: {},
		context: {},
	} as never) as Promise<Response>
}

describe('browser hosted checkout endpoint', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		createCheckout.mockReset().mockResolvedValue({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
			sessionId: 'cs_1',
			processor: 'connect',
		})
	})

	it('creates a hosted checkout and returns the contract response', async () => {
		const response = await post({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
			locale: 'ar',
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
			sessionId: 'cs_1',
			processor: 'connect',
		})
		expect(createCheckout).toHaveBeenCalledWith({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
			locale: 'ar',
		})
		expect(response.headers.get('Cache-Control')).toBe('no-store')
	})

	it('accepts host instead of slug', async () => {
		const response = await post({
			host: 'cafe.example.com',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(response.status).toBe(200)
		expect(createCheckout).toHaveBeenCalledWith({
			slug: undefined,
			host: 'cafe.example.com',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
			locale: null,
		})
	})

	it('rejects customer contact fields', async () => {
		const response = await post({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
			contact: { name: 'Some One', phone: '+15551230000' },
		})
		expect(response.status).toBe(400)
		expect(createCheckout).not.toHaveBeenCalled()
	})

	it('rejects arbitrary success or cancel URLs', async () => {
		for (const extra of [
			{ successUrl: 'https://evil.test/ok' },
			{ cancelUrl: 'https://evil.test/back' },
			{ returnUrl: 'https://evil.test/return' },
		]) {
			const response = await post({
				slug: 'cafe',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
				...extra,
			})
			expect(response.status).toBe(400)
		}
		expect(createCheckout).not.toHaveBeenCalled()
	})

	it('rejects unknown properties, missing identifiers, and bad bodies', async () => {
		expect(
			(
				await post({
					slug: 'cafe',
					orderId: 'ord_1',
					paymentToken: 'tok_1',
					tip: 5,
				})
			).status,
		).toBe(400)
		expect(
			(await post({ orderId: 'ord_1', paymentToken: 'tok_1' })).status,
		).toBe(400)
		expect((await post({ slug: 'cafe', paymentToken: 'tok_1' })).status).toBe(
			400,
		)
		expect((await post('not-json')).status).toBe(400)
		expect(createCheckout).not.toHaveBeenCalled()
	})

	it('requires POST', async () => {
		const response = await action({
			request: new Request(
				'http://localhost:3001/resources/sites/order/checkout',
			),
			params: {},
			context: {},
		} as never)
		expect(response.status).toBe(405)
	})

	it('propagates thrown error responses from the orchestrator', async () => {
		createCheckout.mockRejectedValue(
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
		expect(await response.json()).toEqual({
			error: 'order_not_found',
			retryable: false,
		})
	})

	it('returns a retryable 503 on unexpected orchestrator failures', async () => {
		createCheckout.mockRejectedValue(new Error('boom'))
		const response = await post({
			slug: 'cafe',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({
			error: 'checkout_unavailable',
			retryable: true,
		})
	})
})
