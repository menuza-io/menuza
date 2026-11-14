import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	bindRestaurantOrderPaymentSession,
	fetchPendingRestaurantOrderRefunds,
	fetchRestaurantOrderQuote,
	notifyRestaurantOrderPaymentStatus,
	RegionalOrderApiError,
	reportRestaurantOrderDisputeStatus,
	reportRestaurantOrderRefundStatus,
	requestRestaurantOrderRefundIntent,
} from './regional-order-api.server.ts'

const getRegionalTenantApiUrl = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	getRegionalTenantApiUrl,
}))

vi.stubGlobal('fetch', fetchMock)

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

async function expectRegionalError(
	promise: Promise<unknown>,
): Promise<RegionalOrderApiError> {
	const error = await promise.catch((e: unknown) => e)
	expect(error).toBeInstanceOf(RegionalOrderApiError)
	return error as RegionalOrderApiError
}

describe('regional restaurant order command client', () => {
	beforeEach(() => {
		getRegionalTenantApiUrl
			.mockReset()
			.mockImplementation((region: string | null) =>
				(region || 'us') === 'ksa'
					? 'http://ksa-tenant-api.test'
					: 'http://us-tenant-api.test',
			)
		fetchMock.mockReset().mockResolvedValue(
			jsonResponse({
				orgId: 'org_1',
				orderId: 'ord_1',
				totalCents: 4250,
				currency: 'USD',
				holdExpiresAt: '2026-10-08T12:10:00.000Z',
				status: 'pending',
			}),
		)
	})

	it('fetches a quote with only non-PII identifiers', async () => {
		const quote = await fetchRestaurantOrderQuote({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})

		expect(quote).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			totalCents: 4250,
			currency: 'USD',
			holdExpiresAt: '2026-10-08T12:10:00.000Z',
			status: 'pending',
			paymentStatus: 'pending',
			boundSession: null,
		})

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ method: string; body: string; headers: Record<string, string> },
		]
		expect(url).toBe('http://us-tenant-api.test/api/orders/quote')
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toMatch(/^Bearer .{16,}$/)
		// Nothing but opaque identifiers transits the control plane.
		expect(JSON.parse(init.body)).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
	})

	it('routes KSA orders to the KSA regional origin', async () => {
		await fetchRestaurantOrderQuote({
			dataRegion: 'ksa',
			orgId: 'org_1',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'http://ksa-tenant-api.test/api/orders/quote',
		)
	})

	it('parses a bound session when the regional service reports one', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				orgId: 'org_1',
				orderId: 'ord_1',
				totalCents: 4250,
				currency: 'SAR',
				holdExpiresAt: null,
				status: 'pending',
				sessionId: 's_1',
				processor: 'checkout',
			}),
		)

		const quote = await fetchRestaurantOrderQuote({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(quote.boundSession).toEqual({
			sessionId: 's_1',
			processor: 'checkout',
		})
		expect(quote.currency).toBe('SAR')
		expect(quote.paymentStatus).toBe('pending')
	})

	it('maps a regional paid status onto paymentStatus', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				orgId: 'org_1',
				orderId: 'ord_1',
				totalCents: 4250,
				currency: 'USD',
				holdExpiresAt: null,
				status: 'accepted',
				paymentStatus: 'paid',
			}),
		)
		const quote = await fetchRestaurantOrderQuote({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			paymentToken: 'tok_1',
		})
		expect(quote.paymentStatus).toBe('paid')
	})

	it('fails closed when the echoed org or order does not match', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				orgId: 'org_2',
				orderId: 'ord_1',
				totalCents: 4250,
				currency: 'USD',
				holdExpiresAt: null,
				status: 'pending',
			}),
		)
		await expect(
			fetchRestaurantOrderQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
			}),
		).rejects.toMatchObject({ code: 'org_mismatch' })
	})

	it('surfaces regional rejection codes as typed errors', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ error: 'invalid_payment_token' }, 403),
		)
		const error = await expectRegionalError(
			fetchRestaurantOrderQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				paymentToken: 'forged',
			}),
		)
		expect(error.code).toBe('invalid_payment_token')
		expect(error.httpStatus).toBe(403)
		expect(error.retryable).toBe(false)
	})

	it('marks 5xx regional failures retryable', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500))
		const error = await expectRegionalError(
			fetchRestaurantOrderQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
			}),
		)
		expect(error.retryable).toBe(true)
	})

	it('fails closed when the regional URL for the org region is not configured', async () => {
		getRegionalTenantApiUrl.mockImplementation(() => {
			throw new Error('TENANT_API_URL_KSA is not configured')
		})
		const error = await expectRegionalError(
			fetchRestaurantOrderQuote({
				dataRegion: 'ksa',
				orgId: 'org_1',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
			}),
		)
		expect(error.code).toBe('region_unconfigured')
		// Never falls back to the other region's URL.
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('wraps transport failures as retryable regional errors', async () => {
		fetchMock.mockRejectedValue(new Error('network down'))
		const error = await expectRegionalError(
			bindRestaurantOrderPaymentSession({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				sessionId: 'cs_1',
				processor: 'connect',
			}),
		)
		expect(error.code).toBe('regional_unreachable')
		expect(error.retryable).toBe(true)
	})

	it('binds a session with the exact contract payload', async () => {
		await bindRestaurantOrderPaymentSession({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
		})

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ method: string; body: string },
		]
		expect(url).toBe('http://us-tenant-api.test/api/orders/payment-session')
		expect(JSON.parse(init.body)).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
		})
	})

	it('notifies payment status with terminal states and provider amounts', async () => {
		await notifyRestaurantOrderPaymentStatus({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ method: string; body: string },
		]
		expect(url).toBe('http://us-tenant-api.test/api/orders/payment-status')
		expect(JSON.parse(init.body)).toEqual({
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('forwards the payment id of an order from either provider', async () => {
		for (const [processor, sessionId, paymentId] of [
			['connect', 'cs_1', 'pi_1'],
			['checkout', 'restaurant_order:org_1:ord_1', 'pay_1'],
		] as const) {
			fetchMock
				.mockReset()
				.mockImplementation(async () => jsonResponse({ ok: true }))
			await notifyRestaurantOrderPaymentStatus({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				sessionId,
				processor,
				status: 'paid',
				amountCents: 4250,
				currency: 'usd',
				paymentId,
			})
			expect(fetchMock).toHaveBeenCalledTimes(1)
			const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
			expect(JSON.parse(init.body)).toMatchObject({ processor, paymentId })
		}
	})

	it('keeps a QR tab’s payment id for Checkout.com only', async () => {
		const send = async (
			processor: 'connect' | 'checkout',
			paymentId: string,
		) => {
			fetchMock
				.mockReset()
				.mockImplementation(async () => jsonResponse({ ok: true }))
			await notifyRestaurantOrderPaymentStatus({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'tab:tab-1',
				sessionId: processor === 'connect' ? 'cs_tab_1' : 'ref_tab_1',
				processor,
				status: 'paid',
				amountCents: 4250,
				currency: 'usd',
				paymentId,
			})
			const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
			return JSON.parse(init.body) as Record<string, unknown>
		}
		expect(await send('checkout', 'pay_tab_1')).toMatchObject({
			paymentId: 'pay_tab_1',
		})
		expect(await send('connect', 'pi_tab_1')).not.toHaveProperty('paymentId')
	})

	it('sends a payment again without its id to a region that refuses the field', async () => {
		fetchMock
			.mockReset()
			.mockResolvedValueOnce(
				jsonResponse({ error: 'invalid_request', message: 'Invalid' }, 400),
			)
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
		await notifyRestaurantOrderPaymentStatus({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			sessionId: 'cs_1',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
			paymentId: 'pi_1',
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const bodies = fetchMock.mock.calls.map(
			(call) => JSON.parse((call[1] as { body: string }).body) as object,
		)
		expect(bodies[0]).toHaveProperty('paymentId', 'pi_1')
		expect(bodies[1]).not.toHaveProperty('paymentId')

		// Without an id there is nothing to drop: a 400 stays a 400.
		fetchMock
			.mockReset()
			.mockResolvedValue(jsonResponse({ error: 'invalid_request' }, 400))
		await expect(
			notifyRestaurantOrderPaymentStatus({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				sessionId: 'cs_1',
				processor: 'connect',
				status: 'paid',
				amountCents: 4250,
				currency: 'usd',
			}),
		).rejects.toMatchObject({ httpStatus: 400 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('rejects malformed quote payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ nope: true }))
		await expect(
			fetchRestaurantOrderQuote({
				dataRegion: 'us',
				orgId: 'org_1',
				orderId: 'ord_1',
				paymentToken: 'tok_1',
			}),
		).rejects.toMatchObject({ code: 'invalid_quote_response' })
	})
})

describe('regional refund and dispute client (#80)', () => {
	const REFUND = {
		refundId: 'rf_1',
		orderId: 'ord_1',
		tabPaymentId: null,
		amountCents: 1000,
		currency: 'USD',
		processor: 'connect',
		sessionId: 'cs_1',
		paymentId: null,
		status: 'pending',
		providerRefundId: null,
		createdAt: '2026-11-14T10:00:00.000Z',
		updatedAt: '2026-11-14T10:00:00.000Z',
	}
	const INTENT = {
		orgId: 'org_1',
		orderId: 'ord_1',
		amountCents: 1000,
		note: 'Cold food',
		idempotencyKey: 'idem_key_0001',
		actor: { origin: 'operator' as const, actorId: 'user_1' },
	}

	beforeEach(() => {
		getRegionalTenantApiUrl
			.mockReset()
			.mockImplementation((region: string | null) =>
				(region || 'us') === 'ksa'
					? 'http://ksa-tenant-api.test'
					: 'http://us-tenant-api.test',
			)
		fetchMock.mockReset()
	})

	function sent() {
		const [url, init] = fetchMock.mock.calls.at(-1) as [
			string,
			{ body: string },
		]
		return { url, body: JSON.parse(init.body) as Record<string, unknown> }
	}

	it('books a refund intent in the org’s region and parses the answer', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ...REFUND, replayed: false }))
		const intent = await requestRestaurantOrderRefundIntent({
			dataRegion: 'ksa',
			...INTENT,
		})
		expect(intent).toEqual({ ...REFUND, replayed: false })
		expect(sent()).toEqual({
			url: 'http://ksa-tenant-api.test/api/orders/refund-intent',
			body: INTENT,
		})
	})

	it('refuses to send a body the contract does not allow', async () => {
		const error = await expectRegionalError(
			requestRestaurantOrderRefundIntent({
				dataRegion: 'us',
				...INTENT,
				full: true,
			}),
		)
		expect(error).toMatchObject({ code: 'invalid_request', httpStatus: 400 })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('keeps the region’s refusal code and status, plus refundableCents only', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					error: 'refund_exceeds_payment',
					refundableCents: 250,
					contact: 'never read',
				},
				409,
			),
		)
		const error = await expectRegionalError(
			requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...INTENT }),
		)
		expect(error).toMatchObject({
			code: 'refund_exceeds_payment',
			httpStatus: 409,
			refundableCents: 250,
			retryable: false,
		})
		for (const [code, status] of [
			['refund_pending', 409],
			['payment_disputed', 409],
			['order_not_found', 404],
		] as const) {
			fetchMock.mockResolvedValue(jsonResponse({ error: code }, status))
			const refused = await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...INTENT }),
			)
			expect(refused).toMatchObject({ code, httpStatus: status })
			expect(refused.refundableCents).toBeUndefined()
		}
	})

	describe('members limited to some locations', () => {
		const SCOPED = { ...INTENT, locationIds: ['loc_a'] }

		it('sends the location ids and accepts an answer that confirms the check', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ ...REFUND, replayed: false, locationScoped: true }),
			)
			const intent = await requestRestaurantOrderRefundIntent({
				dataRegion: 'us',
				...SCOPED,
			})
			expect(intent).toMatchObject({ refundId: 'rf_1', locationScoped: true })
			expect(sent().body).toEqual(SCOPED)
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('treats a region that refuses the field (400) as unsupported', async () => {
			fetchMock.mockImplementation(async () =>
				jsonResponse({ error: 'invalid_request' }, 400),
			)
			const error = await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...SCOPED }),
			)
			expect(error).toMatchObject({
				code: 'location_scope_unsupported',
				httpStatus: 403,
			})
			// An unscoped 400 stays what it was.
			const plain = await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...INTENT }),
			)
			expect(plain).toMatchObject({ code: 'invalid_request', httpStatus: 400 })
		})

		it('releases a refund booked without the check and refuses it', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse({ ...REFUND, replayed: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						refundId: 'rf_1',
						orderId: 'ord_1',
						status: 'failed',
						applied: true,
					}),
				)
			const error = await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...SCOPED }),
			)
			expect(error).toMatchObject({
				code: 'location_scope_unsupported',
				httpStatus: 403,
			})
			expect(fetchMock).toHaveBeenCalledTimes(2)
			expect(sent()).toEqual({
				url: 'http://us-tenant-api.test/api/orders/refund-status',
				body: {
					orgId: 'org_1',
					orderId: 'ord_1',
					refundId: 'rf_1',
					processor: 'connect',
					status: 'failed',
					failureCode: 'location_scope_unsupported',
					amountCents: 1000,
					currency: 'USD',
				},
			})
		})

		it('never releases a replayed or already sent refund, but still refuses', async () => {
			for (const answer of [
				{ ...REFUND, replayed: true },
				{ ...REFUND, replayed: false, providerRefundId: 're_1' },
				{ ...REFUND, replayed: false, status: 'succeeded' },
			]) {
				fetchMock.mockReset().mockResolvedValue(jsonResponse(answer))
				const error = await expectRegionalError(
					requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...SCOPED }),
				)
				expect(error.code).toBe('location_scope_unsupported')
				expect(fetchMock).toHaveBeenCalledTimes(1)
			}
		})

		it('refuses more locations than the contract allows without calling the region', async () => {
			const error = await expectRegionalError(
				requestRestaurantOrderRefundIntent({
					dataRegion: 'us',
					...INTENT,
					locationIds: Array.from({ length: 201 }, (_, i) => `loc_${i}`),
				}),
			)
			expect(error.code).toBe('location_scope_unsupported')
			expect(fetchMock).not.toHaveBeenCalled()
		})
	})

	it('refuses an answer for another order or a malformed one', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ ...REFUND, orderId: 'ord_2', replayed: false }),
		)
		expect(
			await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...INTENT }),
			),
		).toMatchObject({ code: 'org_mismatch' })
		fetchMock.mockResolvedValue(jsonResponse({ refundId: 'rf_1' }))
		expect(
			await expectRegionalError(
				requestRestaurantOrderRefundIntent({ dataRegion: 'us', ...INTENT }),
			),
		).toMatchObject({ code: 'invalid_refund_response' })
	})

	it('reports a refund status and a dispute with ids only', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				refundId: 'rf_1',
				orderId: 'ord_1',
				status: 'succeeded',
				applied: true,
			}),
		)
		expect(
			await reportRestaurantOrderRefundStatus({
				dataRegion: 'us',
				orgId: 'org_1',
				refundId: 'rf_1',
				providerRefundId: 're_1',
				status: 'succeeded',
				amountCents: 1000,
				currency: 'USD',
			}),
		).toMatchObject({ applied: true })
		expect(sent()).toEqual({
			url: 'http://us-tenant-api.test/api/orders/refund-status',
			body: {
				orgId: 'org_1',
				refundId: 'rf_1',
				providerRefundId: 're_1',
				status: 'succeeded',
				amountCents: 1000,
				currency: 'USD',
			},
		})

		fetchMock.mockResolvedValue(
			jsonResponse({
				orderId: 'ord_1',
				disputeStatus: 'open',
				disputed: true,
				applied: true,
			}),
		)
		await reportRestaurantOrderDisputeStatus({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			processor: 'connect',
			status: 'open',
		})
		expect(sent()).toEqual({
			url: 'http://us-tenant-api.test/api/orders/dispute-status',
			body: {
				orgId: 'org_1',
				orderId: 'ord_1',
				processor: 'connect',
				status: 'open',
			},
		})
	})

	it('reads pending refunds', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ refunds: [REFUND] }))
		expect(
			await fetchPendingRestaurantOrderRefunds({
				dataRegion: 'us',
				orgId: 'org_1',
				refundId: 'rf_1',
				limit: 1,
			}),
		).toEqual([REFUND])
		expect(sent()).toEqual({
			url: 'http://us-tenant-api.test/api/orders/refunds-pending',
			body: { orgId: 'org_1', refundId: 'rf_1', limit: 1 },
		})
	})

	it('marks unreachable and 5xx regions retryable', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
		expect(
			await expectRegionalError(
				fetchPendingRestaurantOrderRefunds({
					dataRegion: 'us',
					orgId: 'org_1',
				}),
			),
		).toMatchObject({ code: 'regional_unreachable', retryable: true })
	})
})
