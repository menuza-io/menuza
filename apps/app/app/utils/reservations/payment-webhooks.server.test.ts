import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'

const mocks = vi.hoisted(() => ({
	report: vi.fn(),
	org: vi.fn(),
}))

vi.mock('@repo/payments', async (importOriginal) => ({
	...(await importOriginal<object>()),
	isReservationMetadata: () => true,
	mapStripeRefundToReservation: () => ({
		orgId: 'org_1',
		reservationId: 'rsv_1',
		refundRequestId: 'rfd_1',
		late: false,
		processor: 'stripe',
		paymentRef: 'pi_1',
		refundRef: 're_1',
		amountMinor: 500,
		currency: 'USD',
		status: 'succeeded',
	}),
}))
vi.mock('#app/utils/reservations/payments.server.ts', () => ({
	isTerminalReservationEvent: () => true,
	loadReservationPaymentsOrg: mocks.org,
	logReservationPaymentFailure: vi.fn(),
	pushReservationPaymentEvent: vi.fn(),
}))
vi.mock('#app/utils/reservations/regional-payments-api.server.ts', async () => {
	class RegionalPaymentsApiError extends Error {
		constructor(
			public readonly code: string,
			public readonly httpStatus: number,
		) {
			super(code)
		}
	}
	return {
		RegionalPaymentsApiError,
		reportReservationDispute: vi.fn(),
		reportReservationRefundResult: mocks.report,
	}
})
vi.mock('#app/utils/shop.server.ts', () => ({ getShopCommerce: vi.fn() }))

const { handleReservationStripeRefundEvent } =
	await import('./payment-webhooks.server.ts')
const { RegionalPaymentsApiError } =
	await import('#app/utils/reservations/regional-payments-api.server.ts')

const refund = { id: 're_1', metadata: {} } as unknown as Stripe.Refund

describe('reservation webhook delivery to the region', () => {
	beforeEach(() => {
		consoleError.mockImplementation(() => {})
		mocks.report.mockReset().mockResolvedValue(undefined)
		mocks.org.mockReset().mockResolvedValue({ dataRegion: 'us' })
	})

	it.each([404, 409, 422])(
		'acknowledges a final %s rejection so the event is not redelivered forever',
		async (status) => {
			mocks.report.mockRejectedValue(
				new RegionalPaymentsApiError('payment_not_found', status),
			)
			await expect(
				handleReservationStripeRefundEvent(refund),
			).resolves.toBeUndefined()
		},
	)

	it.each([400, 401, 403, 500, 503, 429])(
		'rethrows %s so the provider redelivers instead of the event being lost',
		async (status) => {
			mocks.report.mockRejectedValue(
				new RegionalPaymentsApiError('unauthorized', status),
			)
			await expect(handleReservationStripeRefundEvent(refund)).rejects.toThrow()
		},
	)

	it('delivers a refund result once on success', async () => {
		await handleReservationStripeRefundEvent(refund)
		expect(mocks.report).toHaveBeenCalledTimes(1)
	})
})
