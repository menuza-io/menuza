import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	bindRestaurantOrderPaymentSession,
	fetchRestaurantOrderQuote,
	notifyRestaurantOrderPaymentStatus,
	RegionalOrderApiError,
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
