import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action } from './reservations.payments.ts'

const payments = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('#app/utils/reservations/payments.server.ts', async () => {
	class ReservationPaymentError extends Error {
		constructor(
			public readonly code: string,
			public readonly httpStatus: number,
			public readonly retryable = false,
		) {
			super(code)
		}
	}
	return {
		ReservationPaymentError,
		executeReservationPaymentCommand: payments.execute,
		logReservationPaymentFailure: vi.fn(),
	}
})

const REFUND = {
	kind: 'refund_request',
	orgId: 'org_1',
	refundRequestId: 'rr_1',
}
const EXPIRE = {
	kind: 'checkout_expire',
	orgId: 'org_1',
	reservationId: 'rsv_1',
	sessionId: 'cs_1',
	processor: 'stripe',
}

function call(
	body: unknown,
	init: { method?: string; token?: string | null } = {},
) {
	const url = new URL('http://localhost:3001/resources/reservations/payments')
	const headers: Record<string, string> = {}
	if (init.token !== null) {
		headers.Authorization = `Bearer ${init.token ?? ENV.INTERNAL_COMMAND_TOKEN}`
	}
	return action({
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
		pattern: '/resources/reservations/payments',
	}) as Promise<Response>
}

describe('POST /resources/reservations/payments (regional -> App)', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		payments.execute.mockReset().mockResolvedValue({
			kind: 'refund_request',
			refunds: 1,
			pending: 0,
			failed: 0,
		})
	})

	it('answers 401 without the internal token, before reading or executing anything', async () => {
		const missing = await call(REFUND, { token: null })
		expect(missing.status).toBe(401)
		const wrong = await call(REFUND, { token: 'x'.repeat(40) })
		expect(wrong.status).toBe(401)
		// An unauthenticated malformed body is still 401, not 400.
		expect((await call('not json', { token: null })).status).toBe(401)
		expect(payments.execute).not.toHaveBeenCalled()
	})

	it('is POST only', async () => {
		expect((await call(REFUND, { method: 'GET' })).status).toBe(405)
	})

	it('executes a refund request and answers with counts only', async () => {
		const response = await call(REFUND)
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		expect(await response.json()).toEqual({
			ok: true,
			kind: 'refund_request',
			refunds: 1,
			pending: 0,
			failed: 0,
		})
		expect(payments.execute).toHaveBeenCalledWith(REFUND)
	})

	it('executes a checkout expiry', async () => {
		payments.execute.mockResolvedValue({
			kind: 'checkout_expire',
			expired: true,
		})
		const response = await call(EXPIRE)
		expect(response.status).toBe(200)
		expect(payments.execute).toHaveBeenCalledWith(EXPIRE)
	})

	it('rejects an invalid command with 400 and never echoes the value', async () => {
		for (const body of [
			{ ...REFUND, guestName: 'Alice Smith' },
			{ kind: 'refund_request', orgId: 'org_1' },
			{ kind: 'something_else' },
			'not json',
		]) {
			const response = await call(body)
			expect(response.status).toBe(400)
			const text = await response.text()
			expect(text).not.toContain('Alice')
			expect(JSON.parse(text)).toEqual({
				error: 'invalid_request',
				retryable: false,
			})
		}
		expect(payments.execute).not.toHaveBeenCalled()
	})

	it('answers 503 retryable on a transient failure so the outbox retries', async () => {
		const { ReservationPaymentError } =
			await import('#app/utils/reservations/payments.server.ts')
		payments.execute.mockRejectedValue(
			new ReservationPaymentError('provider_unavailable', 503, true),
		)
		const response = await call(REFUND)
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({
			error: 'provider_unavailable',
			retryable: true,
		})
		payments.execute.mockRejectedValue(new TypeError('secret=abc network down'))
		const unknown = await call(REFUND)
		expect(unknown.status).toBe(503)
		expect(JSON.stringify(await unknown.json())).not.toContain('secret')
	})

	it('answers 404 for an unknown organization (not retryable)', async () => {
		const { ReservationPaymentError } =
			await import('#app/utils/reservations/payments.server.ts')
		payments.execute.mockRejectedValue(
			new ReservationPaymentError('org_not_found', 404),
		)
		const response = await call(REFUND)
		expect(response.status).toBe(404)
		expect(await response.json()).toMatchObject({ retryable: false })
	})
})
