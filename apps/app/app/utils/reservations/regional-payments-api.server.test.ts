import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	bindReservationPaymentSession,
	claimReservationFee,
	claimReservationRefunds,
	fetchPendingReservationPayments,
	fetchReservationPaymentQuote,
	notifyReservationPaymentStatus,
	RegionalPaymentsApiError,
	reportReservationDispute,
	reportReservationFeeResult,
	reportReservationRefundResult,
} from './regional-payments-api.server.ts'

const getRegionalTenantApiUrl = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	getRegionalTenantApiUrl,
}))
vi.stubGlobal('fetch', fetchMock)

const NOW = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T12:20:00.000Z'

function quoteBody(overrides: Record<string, unknown> = {}) {
	return {
		purpose: 'deposit',
		mode: 'payment',
		reservationId: 'rsv_1',
		locationId: 'loc_1',
		feeId: null,
		feeKind: null,
		amountMinor: 5000,
		currency: 'USD',
		quantity: 2,
		unitAmountMinor: 2500,
		expiresAt: LATER,
		now: NOW,
		reservationStatus: 'pending_payment',
		paymentStatus: 'pending',
		locale: 'en',
		boundSession: null,
		providerCustomerRef: null,
		guestRef: 'guest_ref_abcdef',
		productLabel: null,
		policy: {
			kind: 'deposit',
			unitMinor: 2500,
			partySize: 2,
			capMinor: null,
			freeCancelUntilMin: 1440,
			termsVersion: 1,
		},
		consent: null,
		...overrides,
	}
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

async function expectError(promise: Promise<unknown>) {
	const error = await promise.catch((thrown: unknown) => thrown)
	expect(error).toBeInstanceOf(RegionalPaymentsApiError)
	return error as RegionalPaymentsApiError
}

function lastCall() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [
		string,
		{
			method: string
			body: string
			headers: Record<string, string>
			redirect: string
			signal: AbortSignal
		},
	]
	return { url, init, body: JSON.parse(init.body) as Record<string, unknown> }
}

describe('regional reservation payments client', () => {
	beforeEach(() => {
		getRegionalTenantApiUrl
			.mockReset()
			.mockImplementation((region: string | null) =>
				(region || 'us') === 'ksa'
					? 'http://ksa-tenant-api.test'
					: 'http://us-tenant-api.test',
			)
		fetchMock.mockReset().mockResolvedValue(json(quoteBody()))
	})

	it('quote: posts only opaque ids with the internal token and parses with the contract', async () => {
		const quote = await fetchReservationPaymentQuote({
			dataRegion: 'us',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			paymentToken: 'tok_12345678',
			purpose: 'deposit',
		})
		expect(quote).toMatchObject({ amountMinor: 5000, currency: 'USD' })
		const { url, init, body } = lastCall()
		expect(url).toBe(
			'http://us-tenant-api.test/api/reservations/payments/quote',
		)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toMatch(/^Bearer .{16,}$/)
		expect(init.redirect).toBe('manual')
		expect(init.signal).toBeInstanceOf(AbortSignal)
		expect(body).toEqual({
			orgId: 'org_1',
			reservationId: 'rsv_1',
			paymentToken: 'tok_12345678',
			purpose: 'deposit',
		})
	})

	it('quote: a fee quote sends feeId, and a mismatched echo is refused', async () => {
		fetchMock.mockResolvedValue(
			json(
				quoteBody({ purpose: 'fee', feeId: 'fee_1', feeKind: 'no_show_fee' }),
			),
		)
		const quote = await fetchReservationPaymentQuote({
			dataRegion: 'ksa',
			orgId: 'org_1',
			feeId: 'fee_1',
			paymentToken: 'tok_12345678',
			purpose: 'fee',
		})
		expect(quote.feeId).toBe('fee_1')
		expect(lastCall().url).toBe(
			'http://ksa-tenant-api.test/api/reservations/payments/quote',
		)
		expect(lastCall().body).toEqual({
			orgId: 'org_1',
			feeId: 'fee_1',
			paymentToken: 'tok_12345678',
			purpose: 'fee',
		})

		fetchMock.mockResolvedValue(json(quoteBody({ reservationId: 'rsv_other' })))
		const error = await expectError(
			fetchReservationPaymentQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				reservationId: 'rsv_1',
				paymentToken: 'tok_12345678',
				purpose: 'deposit',
			}),
		)
		expect(error).toMatchObject({ code: 'quote_mismatch', httpStatus: 502 })
	})

	it('bind: sends the fee snapshot; 409 codes come back stable', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
		await bindReservationPaymentSession({
			dataRegion: 'us',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit',
			sessionId: 'cs_1',
			processor: 'stripe',
			platformFeeBp: 150,
			platformFeeMinor: 49,
		})
		expect(lastCall().url).toMatch(/\/payments\/bind$/)
		expect(lastCall().body).toEqual({
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'deposit',
			sessionId: 'cs_1',
			processor: 'stripe',
			platformFeeBp: 150,
			platformFeeMinor: 49,
		})
		for (const code of ['already_bound', 'payment_terminal', 'hold_expired']) {
			fetchMock.mockResolvedValue(json({ error: code }, 409))
			const error = await expectError(
				bindReservationPaymentSession({
					dataRegion: 'us',
					orgId: 'org_1',
					reservationId: 'rsv_1',
					purpose: 'deposit',
					sessionId: 'cs_1',
					processor: 'stripe',
					platformFeeBp: 0,
					platformFeeMinor: 0,
				}),
			)
			expect(error).toMatchObject({ code, httpStatus: 409, retryable: false })
		}
	})

	it('status: reports ids, amounts and card facts; parses the outcome and refund directive', async () => {
		fetchMock.mockResolvedValue(
			json({
				outcome: 'refund_required',
				refund: {
					reservationId: 'rsv_1',
					paymentRef: 'pi_1',
					processor: 'stripe',
					amountMinor: 5000,
					currency: 'USD',
					paymentAmountMinor: 5000,
					platformFeeMinor: 75,
				},
			}),
		)
		const result = await notifyReservationPaymentStatus({
			dataRegion: 'us',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			purpose: 'guarantee',
			sessionId: 'cs_1',
			processor: 'stripe',
			status: 'setup_succeeded',
			amountMinor: 0,
			currency: 'USD',
			paymentMethodRef: 'pm_1',
			providerCustomerRef: 'cus_1',
			card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2034 },
		})
		expect(result.outcome).toBe('refund_required')
		expect(result.refund).toMatchObject({
			paymentRef: 'pi_1',
			refundedBeforeMinor: 0,
			feeReversalMinor: 0,
		})
		expect(Object.keys(lastCall().body).sort()).toEqual(
			[
				'amountMinor',
				'card',
				'currency',
				'orgId',
				'paymentMethodRef',
				'processor',
				'providerCustomerRef',
				'purpose',
				'reservationId',
				'sessionId',
				'status',
			].sort(),
		)
	})

	it('fee claim and result, refund claim and result, dispute and pending use the contract paths', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				feeId: 'fee_1',
				reservationId: 'rsv_1',
				locationId: 'loc_1',
				kind: 'no_show_fee',
				attempt: 1,
				amountMinor: 2500,
				currency: 'USD',
				processor: 'stripe',
				providerCustomerRef: 'cus_1',
				paymentMethodRef: 'pm_1',
				previousPaymentRef: null,
			}),
		)
		const claim = await claimReservationFee({
			dataRegion: 'us',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			feeId: 'fee_1',
		})
		expect(claim.attempt).toBe(1)
		expect(lastCall().url).toMatch(/\/payments\/fee-claim$/)

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
		await reportReservationFeeResult({
			dataRegion: 'us',
			orgId: 'org_1',
			reservationId: 'rsv_1',
			feeId: 'fee_1',
			attempt: 1,
			paymentRef: 'pi_1',
			status: 'failed',
			declineCode: 'generic_decline',
			platformFeeBp: 150,
			platformFeeMinor: 37,
		})
		expect(lastCall().url).toMatch(/\/payments\/fee-result$/)
		expect(lastCall().body).toMatchObject({ declineCode: 'generic_decline' })

		fetchMock.mockResolvedValueOnce(
			json({
				refunds: [
					{
						refundRequestId: 'rr_1',
						reservationId: 'rsv_1',
						paymentRef: 'pi_1',
						processor: 'stripe',
						amountMinor: 1000,
						currency: 'USD',
						paymentAmountMinor: 5000,
						platformFeeMinor: 75,
						feeReversalMinor: 15,
					},
				],
			}),
		)
		const refunds = await claimReservationRefunds({
			dataRegion: 'us',
			orgId: 'org_1',
			refundRequestId: 'rr_1',
		})
		expect(refunds[0]).toMatchObject({
			refundRequestId: 'rr_1',
			feeReversalMinor: 15,
		})
		expect(lastCall().url).toMatch(/\/payments\/refund-claim$/)

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
		await reportReservationRefundResult({
			dataRegion: 'us',
			orgId: 'org_1',
			refundRequestId: 'rr_1',
			refundRef: 're_1',
			amountMinor: 1000,
			status: 'pending',
		})
		expect(lastCall().url).toMatch(/\/payments\/refund-result$/)

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
		await reportReservationDispute({
			dataRegion: 'us',
			orgId: 'org_1',
			paymentRef: 'pi_1',
			disputeRef: 'dp_1',
			status: 'opened',
		})
		expect(lastCall().url).toMatch(/\/payments\/dispute$/)

		fetchMock.mockResolvedValueOnce(
			json({
				sessions: [
					{
						reservationId: 'rsv_1',
						feeId: null,
						purpose: 'deposit',
						sessionId: 'cs_1',
						processor: 'stripe',
						amountMinor: 5000,
						currency: 'USD',
					},
				],
				refunds: [
					{
						refundRequestId: 'rr_2',
						reservationId: 'rsv_1',
						paymentRef: 'pi_1',
						processor: 'stripe',
						refundRef: null,
						amountMinor: 500,
						currency: 'USD',
						paymentAmountMinor: 5000,
						platformFeeMinor: 75,
						feeReversalMinor: 8,
					},
				],
			}),
		)
		const pending = await fetchPendingReservationPayments({
			dataRegion: 'us',
			orgId: 'org_1',
		})
		expect(pending.sessions).toHaveLength(1)
		expect(pending.refunds[0]!.refundRef).toBeNull()
		expect(lastCall().url).toMatch(/\/payments\/pending$/)
		expect(lastCall().body).toEqual({ orgId: 'org_1' })
	})

	it('refuses a body that carries anything beyond the contract, without echoing it', async () => {
		const error = await expectError(
			reportReservationDispute({
				dataRegion: 'us',
				orgId: 'org_1',
				paymentRef: 'pi_1',
				disputeRef: 'dp_1',
				status: 'opened',
				guestName: 'Alice Smith',
			} as never),
		)
		expect(error.code).toBe('invalid_request')
		expect(error.message).not.toContain('Alice')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('maps failures to stable codes: unreachable, 5xx retryable, 4xx not, redirect, invalid response', async () => {
		const ask = () =>
			fetchReservationPaymentQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				reservationId: 'rsv_1',
				paymentToken: 'tok_12345678',
				purpose: 'deposit',
			})

		fetchMock.mockRejectedValue(new TypeError('boom secret=abc'))
		const unreachable = await expectError(ask())
		expect(unreachable).toMatchObject({
			code: 'regional_unreachable',
			httpStatus: 503,
			retryable: true,
		})
		expect(unreachable.message).not.toContain('secret')

		fetchMock.mockResolvedValue(json({ error: 'upstream_down' }, 502))
		expect(await expectError(ask())).toMatchObject({ retryable: true })
		fetchMock.mockResolvedValue(json({ error: 'Not A Code!' }, 429))
		expect(await expectError(ask())).toMatchObject({
			code: 'http_429',
			retryable: true,
		})
		fetchMock.mockResolvedValue(json({ error: 'invalid_payment_token' }, 404))
		expect(await expectError(ask())).toMatchObject({
			code: 'invalid_payment_token',
			retryable: false,
		})
		fetchMock.mockResolvedValue(
			new Response(null, { status: 302, headers: { Location: 'http://evil' } }),
		)
		expect(await expectError(ask())).toMatchObject({
			code: 'unexpected_redirect',
		})
		fetchMock.mockResolvedValue(json({ unexpected: true }))
		expect(await expectError(ask())).toMatchObject({
			code: 'invalid_response',
			httpStatus: 502,
		})
		fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
		expect(await expectError(ask())).toMatchObject({ code: 'invalid_response' })
	})

	it('fails closed when the region has no configured origin', async () => {
		getRegionalTenantApiUrl.mockImplementation(() => {
			throw new Error('TENANT_API_URL_KSA is not configured')
		})
		const error = await expectError(
			fetchReservationPaymentQuote({
				dataRegion: 'ksa',
				orgId: 'org_1',
				reservationId: 'rsv_1',
				paymentToken: 'tok_12345678',
				purpose: 'deposit',
			}),
		)
		expect(error).toMatchObject({
			code: 'region_unconfigured',
			httpStatus: 503,
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
