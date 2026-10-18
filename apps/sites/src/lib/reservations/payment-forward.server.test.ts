import { describe, expect, it, vi } from 'vitest'
import {
	forwardReservationPayment,
	parseReservationPaymentBody,
} from './payment-forward.server.ts'

vi.mock('~/lib/worker-env', () => ({
	getAppServiceBinding: () => null,
	getPublicAppUrl: () => 'https://app.example',
	getReservationPaymentToken: () => 'server-token-123456',
}))

const ref = {
	reservationId: 'rsv_1',
	paymentToken: 'opaque-payment-token',
	purpose: 'deposit',
	locale: 'en',
}
const request = (body: unknown, origin = 'https://cafe.example') =>
	new Request('https://cafe.example/api/reservations/payment', {
		method: 'POST',
		headers: { Origin: origin, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
const scope = (send: unknown, extra = {}) => ({
	slug: 'cafe',
	fetchImpl: send as typeof fetch,
	production: true,
	...extra,
})

describe('reservation payment body', () => {
	it('accepts opaque ids only', () => {
		expect(parseReservationPaymentBody(ref)).toEqual(ref)
		expect(
			parseReservationPaymentBody({
				feeId: 'pay_9',
				paymentToken: 'opaque-payment-token',
				purpose: 'fee',
			}),
		).not.toBeNull()
	})
	it('rejects guest data, urls, amounts and mixed ids', () => {
		for (const extra of [
			{ guest: { firstName: 'A' } },
			{ amountMinor: 1 },
			{ checkoutUrl: 'https://x' },
			{ slug: 'other' },
			{ feeId: 'pay_9' },
		]) {
			expect(parseReservationPaymentBody({ ...ref, ...extra })).toBeNull()
		}
		expect(
			parseReservationPaymentBody({ ...ref, reservationId: 'a b' }),
		).toBeNull()
		expect(parseReservationPaymentBody({ ...ref, purpose: 'fee' })).toBeNull()
	})
})

describe('forwardReservationPayment', () => {
	it('rejects cross-origin and invalid bodies before calling the App', async () => {
		const send = vi.fn()
		expect(
			(
				await forwardReservationPayment(
					request(ref, 'https://evil.example'),
					'checkout',
					scope(send),
				)
			).status,
		).toBe(403)
		expect(
			(
				await forwardReservationPayment(
					request({ ...ref, name: 'x' }),
					'checkout',
					scope(send),
				)
			).status,
		).toBe(400)
		expect(send).not.toHaveBeenCalled()
	})

	it('derives the organization from the host, never the body, and sends the server token', async () => {
		const send = vi.fn(async () =>
			Response.json({
				checkoutUrl: 'https://checkout.example/s/1',
				sessionId: 'cs_1',
				processor: 'connect',
				purpose: 'deposit',
				mode: 'payment',
				secret: 'dropped',
			}),
		)
		const res = await forwardReservationPayment(
			request(ref),
			'checkout',
			scope(send),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			checkoutUrl: 'https://checkout.example/s/1',
			sessionId: 'cs_1',
			processor: 'connect',
			purpose: 'deposit',
			mode: 'payment',
		})
		const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://app.example/resources/sites/reservation/checkout')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer server-token-123456',
		)
		expect(JSON.parse(String(init.body))).toEqual({ ...ref, slug: 'cafe' })
	})

	it('refuses a non-https checkout url in production', async () => {
		const send = vi.fn(async () =>
			Response.json({ checkoutUrl: 'http://localhost:3001/mock-payments/x' }),
		)
		const res = await forwardReservationPayment(
			request(ref),
			'checkout',
			scope(send),
		)
		expect(res.status).toBe(502)
		const dev = await forwardReservationPayment(
			request(ref),
			'checkout',
			scope(send, { production: false }),
		)
		expect(dev.status).toBe(200)
	})

	it('returns only status fields and passes definite codes through', async () => {
		const ok = await forwardReservationPayment(
			request(ref),
			'status',
			scope(
				vi.fn(async () =>
					Response.json({
						paymentStatus: 'paid',
						reservationStatus: 'booked',
						expiresAt: '2026-01-01T00:00:00.000Z',
						purpose: 'deposit',
						mode: 'payment',
						processor: 'connect',
					}),
				),
			),
		)
		expect(Object.keys(await ok.json()).sort()).toEqual([
			'expiresAt',
			'mode',
			'paymentStatus',
			'purpose',
			'reservationStatus',
		])
		const refused = await forwardReservationPayment(
			request(ref),
			'checkout',
			scope(
				vi.fn(async () =>
					Response.json(
						{ error: 'online_payment_unavailable' },
						{ status: 409 },
					),
				),
			),
		)
		expect(refused.status).toBe(409)
		expect((await refused.json()).error).toBe('online_payment_unavailable')
	})

	it('answers 503 without a server token and 404 without a site', async () => {
		const send = vi.fn()
		expect(
			(
				await forwardReservationPayment(
					request(ref),
					'status',
					scope(send, { token: null }),
				)
			).status,
		).toBe(503)
		expect(
			(
				await forwardReservationPayment(
					request(ref),
					'status',
					scope(send, { slug: null }),
				)
			).status,
		).toBe(404)
		expect(send).not.toHaveBeenCalled()
	})
})
