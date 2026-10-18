import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action as checkoutAction } from './sites.reservation.checkout.ts'
import { action as statusAction } from './sites.reservation.status.ts'

const payments = vi.hoisted(() => ({ checkout: vi.fn(), status: vi.fn() }))
vi.mock('#app/utils/reservations/payments.server.ts', () => ({
	createReservationHostedCheckout: payments.checkout,
	getReservationPaymentStatus: payments.status,
	logReservationPaymentFailure: vi.fn(),
}))

type RouteAction = typeof checkoutAction

function call(
	route: RouteAction,
	path: string,
	body: unknown,
	init: { method?: string; token?: string | null } = {},
) {
	const url = new URL(`http://localhost:3001${path}`)
	const headers: Record<string, string> = {}
	if (init.token !== null) {
		headers.Authorization = `Bearer ${init.token ?? ENV.INTERNAL_COMMAND_TOKEN}`
	}
	return route({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers,
			...((init.method ?? 'POST') === 'GET'
				? {}
				: { body: typeof body === 'string' ? body : JSON.stringify(body) }),
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: path,
	} as never) as Promise<Response>
}

const checkout = (body: unknown, init?: Parameters<typeof call>[3]) =>
	call(checkoutAction, '/resources/sites/reservation/checkout', body, init)
const status = (body: unknown, init?: Parameters<typeof call>[3]) =>
	call(statusAction, '/resources/sites/reservation/status', body, init)

const DEPOSIT = {
	slug: 'cafe',
	reservationId: 'rsv_1',
	paymentToken: 'tok_12345678',
	purpose: 'deposit',
	locale: 'ar',
}
const FEE = {
	host: 'cafe.example.com',
	feeId: 'fee_1',
	paymentToken: 'tok_12345678',
	purpose: 'fee',
}

describe.each([
	['checkout', checkout],
	['status', status],
])('Sites -> App reservation %s route', (name, route) => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		payments.checkout.mockReset().mockResolvedValue({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
			sessionId: 'cs_1',
			processor: 'connect',
			purpose: 'deposit',
			mode: 'payment',
		})
		payments.status.mockReset().mockResolvedValue({
			purpose: 'deposit',
			mode: 'payment',
			paymentStatus: 'paid',
			reservationStatus: 'booked',
			expiresAt: '2026-10-08T12:20:00.000Z',
			processor: 'connect',
		})
	})

	it('answers 401 without the internal token and never reads the body or calls the payment code', async () => {
		expect((await route(DEPOSIT, { token: null })).status).toBe(401)
		expect((await route(DEPOSIT, { token: 'y'.repeat(40) })).status).toBe(401)
		expect((await route('garbage', { token: null })).status).toBe(401)
		expect(payments.checkout).not.toHaveBeenCalled()
		expect(payments.status).not.toHaveBeenCalled()
	})

	it('is POST only', async () => {
		expect((await route(DEPOSIT, { method: 'GET' })).status).toBe(405)
	})

	it('rejects bodies outside the opaque contract (guest data, URLs, both ids, neither id) without echoing them', async () => {
		const bad: unknown[] = [
			{ ...DEPOSIT, guestName: 'Alice Smith' },
			{ ...DEPOSIT, successUrl: 'https://evil.example' },
			{ ...DEPOSIT, feeId: 'fee_1' },
			{ slug: 'cafe', paymentToken: 'tok_12345678', purpose: 'deposit' },
			{ ...DEPOSIT, host: 'cafe.example.com' },
			{ ...DEPOSIT, paymentToken: 'short' },
			{ ...DEPOSIT, purpose: 'bogus' },
			{ ...FEE, reservationId: 'rsv_1' },
			'not json',
		]
		for (const body of bad) {
			const response = await route(body)
			expect(response.status).toBe(400)
			expect(await response.text()).not.toMatch(/Alice|evil\.example/)
		}
		expect(payments.checkout).not.toHaveBeenCalled()
		expect(payments.status).not.toHaveBeenCalled()
	})

	it(`passes only the opaque fields to the ${name} code (${'slug'} and ${'host'} variants)`, async () => {
		const fn = name === 'checkout' ? payments.checkout : payments.status
		const response = await route(DEPOSIT)
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		expect(fn).toHaveBeenCalledWith({
			slug: 'cafe',
			reservationId: 'rsv_1',
			paymentToken: 'tok_12345678',
			purpose: 'deposit',
			locale: 'ar',
		})
		await route(FEE)
		expect(fn).toHaveBeenLastCalledWith({
			host: 'cafe.example.com',
			feeId: 'fee_1',
			paymentToken: 'tok_12345678',
			purpose: 'fee',
			locale: null,
		})
	})

	it('returns the thrown error response of the payment code as is', async () => {
		const fn = name === 'checkout' ? payments.checkout : payments.status
		fn.mockRejectedValue(
			Response.json(
				{ error: 'already_paid', retryable: false },
				{ status: 409 },
			),
		)
		const response = await route(DEPOSIT)
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({
			error: 'already_paid',
			retryable: false,
		})
	})

	it('answers 503 retryable for an unexpected failure without leaking it', async () => {
		const fn = name === 'checkout' ? payments.checkout : payments.status
		fn.mockRejectedValue(new TypeError('secret=abc'))
		const response = await route(DEPOSIT)
		expect(response.status).toBe(503)
		const text = await response.text()
		expect(text).not.toContain('secret')
		expect(JSON.parse(text)).toMatchObject({ retryable: true })
	})
})

describe('response shapes', () => {
	it('checkout returns the URL, id, processor, purpose and mode', async () => {
		payments.checkout.mockResolvedValue({
			checkoutUrl: 'https://pay.example/1',
			sessionId: 'cs_1',
			processor: 'checkout',
			purpose: 'guarantee',
			mode: 'setup',
		})
		const response = await checkout(DEPOSIT)
		expect(await response.json()).toEqual({
			checkoutUrl: 'https://pay.example/1',
			sessionId: 'cs_1',
			processor: 'checkout',
			purpose: 'guarantee',
			mode: 'setup',
		})
	})

	it('status returns the regional view only', async () => {
		payments.status.mockResolvedValue({
			purpose: 'deposit',
			mode: 'payment',
			paymentStatus: 'pending',
			reservationStatus: 'pending_payment',
			expiresAt: '2026-10-08T12:20:00.000Z',
			processor: null,
		})
		const response = await status(DEPOSIT)
		expect(await response.json()).toMatchObject({
			paymentStatus: 'pending',
			processor: null,
		})
	})
})
