import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { action as feeAction } from './reservations.payments.fee.ts'
import { action as refundAction } from './reservations.payments.refund.ts'

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	impersonating: vi.fn(),
	charge: vi.fn(),
	refund: vi.fn(),
}))

vi.mock('@repo/auth', () => ({ isImpersonating: mocks.impersonating }))
vi.mock('#app/utils/reservations/access.server.ts', () => ({
	requireReservationsAccess: mocks.access,
}))
vi.mock('#app/utils/reservations/payments.server.ts', () => {
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
		chargeReservationFee: mocks.charge,
		executeReservationRefundRequest: mocks.refund,
		logReservationPaymentFailure: vi.fn(),
	}
})

type RouteAction = typeof feeAction

function call(
	route: RouteAction,
	path: string,
	body: unknown,
	init: { method?: string; query?: string } = {},
) {
	const url = new URL(
		`http://localhost:3001${path}${init.query ?? '?orgSlug=cafe'}`,
	)
	return route({
		request: new Request(url, {
			method: init.method ?? 'POST',
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

const FEE_PATH = '/resources/reservations/payments/fee'
const REFUND_PATH = '/resources/reservations/payments/refund'
const fee = (body: unknown, init?: Parameters<typeof call>[3]) =>
	call(feeAction, FEE_PATH, body, init)
const refund = (body: unknown, init?: Parameters<typeof call>[3]) =>
	call(refundAction, REFUND_PATH, body, init)

beforeEach(() => {
	consoleError.mockImplementation(() => {})
	mocks.access.mockReset().mockResolvedValue({ organizationId: 'org_1' })
	mocks.impersonating.mockReset().mockResolvedValue(false)
	mocks.charge.mockReset().mockResolvedValue({
		feeId: 'fee_1',
		attempt: 1,
		status: 'succeeded',
		declineCode: null,
	})
	mocks.refund.mockReset().mockResolvedValue({
		refunds: 1,
		pending: 0,
		failed: 0,
	})
})

describe.each([
	['fee', fee, { reservationId: 'rsv_1', feeId: 'fee_1' }],
	['refund', refund, { refundRequestId: 'rr_1' }],
] as const)('operator %s action', (name, route, body) => {
	const work = () => (name === 'fee' ? mocks.charge : mocks.refund)

	it('awaits requireReservationsAccess with the payments feature and the payment grant first', async () => {
		await route(body)
		expect(mocks.access).toHaveBeenCalledTimes(1)
		const [, orgSlug, options] = mocks.access.mock.calls[0]!
		expect(orgSlug).toBe('cafe')
		expect(options).toEqual({
			feature: 'payments',
			anyOf: ['update:reservation_payment:any'],
		})
	})

	it('refuses everything the guard refuses (no session, flag off, no grant) before touching the body', async () => {
		for (const status of [401, 403, 404]) {
			mocks.access.mockRejectedValue(new Response('no', { status }))
			const thrown = await route(body).catch((error) => error)
			expect(thrown).toBeInstanceOf(Response)
			expect((thrown as Response).status).toBe(status)
		}
		expect(work()).not.toHaveBeenCalled()
	})

	it('refuses an impersonated session', async () => {
		mocks.impersonating.mockResolvedValue(true)
		const response = await route(body)
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ error: 'impersonation_forbidden' })
		expect(work()).not.toHaveBeenCalled()
	})

	it('is POST only', async () => {
		expect((await route(body, { method: 'GET' })).status).toBe(405)
		expect(mocks.access).not.toHaveBeenCalled()
	})

	it('rejects a malformed body with 400 and never echoes it', async () => {
		for (const bad of [{ ...body, guestName: 'Alice' }, {}, 'not json']) {
			const response = await route(bad)
			expect(response.status).toBe(400)
			expect(await response.text()).not.toContain('Alice')
		}
		expect(work()).not.toHaveBeenCalled()
	})

	it('hands the operator location scope to the privileged payment bridge', async () => {
		for (const locationIds of [null, ['loc_a'], []]) {
			mocks.access.mockResolvedValue({
				organizationId: 'org_1',
				locationIds,
			})
			await route({ ...body })
			const [input] = work().mock.calls.at(-1)!
			expect(input.locationIds).toEqual(locationIds)
		}
	})

	it('uses the organization of the session, never one from the body', async () => {
		await route({ ...body })
		const [input] = work().mock.calls[0]!
		expect(input.orgId).toBe('org_1')
	})

	it('maps typed errors to their status and unexpected ones to a retryable 503', async () => {
		const { ReservationPaymentError } =
			await import('#app/utils/reservations/payments.server.ts')
		work().mockRejectedValue(
			new ReservationPaymentError('fee_not_claimable', 409),
		)
		const typed = await route(body)
		expect(typed.status).toBe(409)
		expect(await typed.json()).toEqual({
			error: 'fee_not_claimable',
			retryable: false,
		})
		work().mockRejectedValue(new TypeError('secret=abc'))
		const unknown = await route(body)
		expect(unknown.status).toBe(503)
		expect(JSON.stringify(await unknown.json())).not.toContain('secret')
	})
})

describe('operator fee and refund results', () => {
	it('fee: returns the charge outcome only', async () => {
		const response = await fee({ reservationId: 'rsv_1', feeId: 'fee_1' })
		expect(await response.json()).toEqual({
			feeId: 'fee_1',
			attempt: 1,
			status: 'succeeded',
			declineCode: null,
		})
		expect(mocks.charge).toHaveBeenCalledWith({
			orgId: 'org_1',
			reservationId: 'rsv_1',
			feeId: 'fee_1',
		})
	})

	it('refund: returns counts only', async () => {
		const response = await refund({ refundRequestId: 'rr_1' })
		expect(await response.json()).toEqual({ refunds: 1, pending: 0, failed: 0 })
		expect(mocks.refund).toHaveBeenCalledWith({
			orgId: 'org_1',
			refundRequestId: 'rr_1',
		})
	})
})
