import type * as DatabaseModule from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleTable, mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import {
	createRestaurantOrderHostedCheckout,
	getRestaurantOrderPaymentStatus,
} from './checkout.server.ts'
import type * as RegionalOrderApiModule from './regional-order-api.server.ts'
import { RegionalOrderApiError } from './regional-order-api.server.ts'

// Imported lazily: a static `@repo/payments` import initializes the payments
// entry (route handlers → @repo/database) before this file's module mocks are
// wired, which trips vitest's hoisting.
const { buildRestaurantOrderSessionIdempotencyKey } =
	await import('@repo/payments')

const findOrg = vi.hoisted(() => vi.fn())
const regional = vi.hoisted(() => ({
	fetchRestaurantOrderQuote: vi.fn(),
	bindRestaurantOrderPaymentSession: vi.fn(),
	notifyRestaurantOrderPaymentStatus: vi.fn(),
}))
const commerce = vi.hoisted(() => ({
	createCheckout: vi.fn(),
	retrieveConnectCheckoutSession: vi.fn(),
	expireConnectCheckoutSession: vi.fn(),
	isProcessorConfigured: vi.fn(),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		and: (...args: unknown[]) => args,
		eq: (...args: unknown[]) => args,
		inArray: (...args: unknown[]) => args,
	}
})

vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalOrderApiModule>()
		return {
			...actual,
			...regional,
		}
	},
)

vi.mock('#app/utils/shop.server.ts', () => ({
	getShopCommerce: () => commerce,
	getSiteBaseUrl: (org: { slug: string; customDomain: string | null }) =>
		org.customDomain
			? `https://${org.customDomain}`
			: `https://${org.slug}.sites.test`,
}))

const ORG_ID = 'org_1'
const ORDER_ID = 'ord_1'

const NOW = new Date('2026-10-08T12:00:00.000Z')

afterEach(() => {
	vi.useRealTimers()
})

function orgRow(
	overrides: Partial<{
		dataRegion: string
		customDomain: string | null
		siteDefaultLocale: string | null
		siteLocales: string | null
		shopPaymentProvider: string
		stripeConnectAccountId: string | null
		stripeConnectChargesEnabled: boolean
		checkoutSubEntityId: string | null
		checkoutChargesEnabled: boolean
	}> = {},
) {
	return {
		id: ORG_ID,
		name: 'Cafe',
		slug: 'cafe',
		dataRegion: 'us',
		hasProvisionedDb: true,
		customDomain: 'cafe.example.com',
		siteDefaultLocale: 'en',
		siteLocales: '["en","ar"]',
		shopPaymentProvider: 'stripe',
		stripeConnectAccountId: 'acct_1',
		stripeConnectChargesEnabled: true,
		checkoutSubEntityId: null,
		checkoutChargesEnabled: false,
		...overrides,
	}
}

function quote(
	overrides: Partial<{
		totalCents: number
		currency: string
		holdExpiresAt: string | null
		status: string
		paymentStatus: 'paid' | 'pending' | 'failed' | 'unknown'
		boundSession: {
			sessionId: string
			processor: 'connect' | 'checkout'
		} | null
	}> = {},
) {
	return {
		orgId: ORG_ID,
		orderId: ORDER_ID,
		totalCents: 4250,
		currency: 'USD',
		holdExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
		status: 'pending',
		paymentStatus: 'pending' as const,
		boundSession: null,
		...overrides,
	}
}

function stripeSession(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'cs_bound',
		url: 'https://checkout.stripe.com/c/pay/cs_bound',
		status: 'open',
		payment_status: 'unpaid',
		amount_total: 4250,
		currency: 'usd',
		metadata: {
			type: 'restaurant_order',
			orgId: ORG_ID,
			orderId: ORDER_ID,
		},
		...overrides,
	}
}

function checkoutOptions() {
	return {
		slug: 'cafe',
		orderId: ORDER_ID,
		paymentToken: 'tok_1',
	}
}

describe('restaurant order hosted checkout', () => {
	beforeEach(() => {
		resetMockDb()
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		consoleError.mockImplementation(() => {})

		findOrg.mockReset().mockResolvedValue(orgRow())
		regional.fetchRestaurantOrderQuote.mockReset().mockResolvedValue(quote())
		regional.bindRestaurantOrderPaymentSession
			.mockReset()
			.mockResolvedValue(undefined)
		regional.notifyRestaurantOrderPaymentStatus
			.mockReset()
			.mockResolvedValue(undefined)
		commerce.createCheckout.mockReset().mockResolvedValue({
			id: 'cs_new',
			url: 'https://checkout.stripe.com/c/pay/cs_new',
			processor: 'connect',
		})
		commerce.retrieveConnectCheckoutSession
			.mockReset()
			.mockResolvedValue(stripeSession())
		commerce.expireConnectCheckoutSession
			.mockReset()
			.mockResolvedValue(undefined)
		commerce.isProcessorConfigured.mockReset().mockReturnValue(true)
	})

	it('creates a session from the authoritative regional quote and binds before returning', async () => {
		const result = await createRestaurantOrderHostedCheckout(checkoutOptions())

		expect(result).toEqual({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_new',
			sessionId: 'cs_new',
			processor: 'connect',
		})

		// The quote is fetched for the org resolved from the slug, never from a
		// client-supplied org id.
		expect(regional.fetchRestaurantOrderQuote).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: ORG_ID,
			orderId: ORDER_ID,
			paymentToken: 'tok_1',
		})

		const options = commerce.createCheckout.mock.calls[0]?.[0]
		expect(options).toMatchObject({
			processor: 'connect',
			// Generic product name and no description: no customer data or
			// cart contents may reach the provider.
			productName: 'Restaurant order',
			productDescription: null,
			amountCents: 4250,
			currency: 'usd',
			connectAccountId: 'acct_1',
			// Only the opaque order id and a validated locale path ride the URLs.
			successUrl: 'https://cafe.example.com/menu/success?order=ord_1',
			cancelUrl: 'https://cafe.example.com/menu',
			metadata: { type: 'restaurant_order', orgId: ORG_ID, orderId: ORDER_ID },
			customerEmail: null,
			externalCustomerId: null,
			embedOrigin: null,
		})
		// A 10-minute hold is inside Stripe's 30-minute minimum: no expires_at.
		expect(options.expiresAt).toBeNull()
		expect(options.idempotencyKey).toBe(
			buildRestaurantOrderSessionIdempotencyKey({
				orgId: ORG_ID,
				orderId: ORDER_ID,
				amountCents: 4250,
				currency: 'USD',
				holdExpiresAt: quote().holdExpiresAt,
			}),
		)

		// Bound regionally before the URL is returned.
		expect(regional.bindRestaurantOrderPaymentSession).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: ORG_ID,
			orderId: ORDER_ID,
			sessionId: 'cs_new',
			processor: 'connect',
		})
	})

	it('aligns the provider session expiry with a long hold', async () => {
		const holdExpiresAt = new Date(NOW.getTime() + 60 * 60_000).toISOString()
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ holdExpiresAt }),
		)

		await createRestaurantOrderHostedCheckout(checkoutOptions())

		const options = commerce.createCheckout.mock.calls[0]?.[0]
		expect(options.expiresAt).toBeInstanceOf(Date)
		expect(options.expiresAt.getTime()).toBe(new Date(holdExpiresAt).getTime())
	})

	it('routes through the requested locale and falls back for invalid locales', async () => {
		await createRestaurantOrderHostedCheckout({
			...checkoutOptions(),
			locale: 'ar',
		})
		expect(commerce.createCheckout.mock.calls[0]?.[0]).toMatchObject({
			successUrl: 'https://cafe.example.com/ar/menu/success?order=ord_1',
			cancelUrl: 'https://cafe.example.com/ar/menu',
		})

		await createRestaurantOrderHostedCheckout({
			...checkoutOptions(),
			locale: 'xx-invalid',
		})
		expect(commerce.createCheckout.mock.calls[1]?.[0]).toMatchObject({
			successUrl: 'https://cafe.example.com/menu/success?order=ord_1',
		})

		// Catalog locale the org has not enabled also falls back to the default.
		await createRestaurantOrderHostedCheckout({
			...checkoutOptions(),
			locale: 'fr',
		})
		expect(commerce.createCheckout.mock.calls[2]?.[0]).toMatchObject({
			successUrl: 'https://cafe.example.com/menu/success?order=ord_1',
		})
	})

	it('creates Checkout.com sessions with the right currency and billing country', async () => {
		findOrg.mockResolvedValue(
			orgRow({
				shopPaymentProvider: 'checkout',
				stripeConnectAccountId: null,
				stripeConnectChargesEnabled: false,
				checkoutSubEntityId: 'ent_1',
				checkoutChargesEnabled: true,
			}),
		)
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ currency: 'SAR', totalCents: 15000 }),
		)

		const result = await createRestaurantOrderHostedCheckout(checkoutOptions())
		expect(result.processor).toBe('checkout')

		expect(commerce.createCheckout.mock.calls[0]?.[0]).toMatchObject({
			processor: 'checkout',
			currency: 'sar',
			amountCents: 15000,
			checkoutSubEntityId: 'ent_1',
			reference: `restaurant_order:${ORG_ID}:${ORDER_ID}`,
			billingCountry: 'SA',
			idempotencyKey: null,
			expiresAt: null,
		})
		expect(
			commerce.createCheckout.mock.calls[0]?.[0].connectAccountId,
		).toBeNull()

		// CAD billing country for Canadian dollars.
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ currency: 'CAD' }),
		)
		await createRestaurantOrderHostedCheckout(checkoutOptions())
		expect(commerce.createCheckout.mock.calls[1]?.[0]).toMatchObject({
			billingCountry: 'CA',
			currency: 'cad',
		})
	})

	it('fails closed when online payment is not configured for the org', async () => {
		findOrg.mockResolvedValue(orgRow({ stripeConnectChargesEnabled: false }))
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({
			status: 409,
		})
		expect(regional.fetchRestaurantOrderQuote).not.toHaveBeenCalled()
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('fails closed when the org processor has no platform credentials', async () => {
		commerce.isProcessorConfigured.mockReturnValue(false)
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({ status: 409 })
		expect(regional.fetchRestaurantOrderQuote).not.toHaveBeenCalled()
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('fails closed for merchant-of-record (static product) orgs', async () => {
		findOrg.mockResolvedValue(orgRow({ shopPaymentProvider: 'polar' }))
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({ status: 409 })
	})

	it('rejects cross-org or invalid payment tokens without creating a session', async () => {
		regional.fetchRestaurantOrderQuote.mockRejectedValue(
			new RegionalOrderApiError('invalid_payment_token', 403),
		)
		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 404 })
		expect(await (response as Response).json()).toEqual({
			error: 'order_not_found',
			retryable: false,
		})
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('returns a retryable 503 when the regional service is unreachable', async () => {
		regional.fetchRestaurantOrderQuote.mockRejectedValue(
			new RegionalOrderApiError('regional_unreachable', 503),
		)
		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 503 })
		expect(await (response as Response).json()).toMatchObject({
			error: 'regional_unavailable',
			retryable: true,
		})
	})

	it('does not create sessions for paid, failed, or expired-hold orders', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ paymentStatus: 'paid' }),
		)
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({ status: 409 })
		expect(commerce.createCheckout).not.toHaveBeenCalled()

		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ paymentStatus: 'failed' }),
		)
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({ status: 409 })

		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({ holdExpiresAt: new Date(NOW.getTime() - 60_000).toISOString() }),
		)
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions()),
		).rejects.toMatchObject({ status: 409 })
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('recovers an already-bound live Stripe session instead of creating a second one', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)

		const result = await createRestaurantOrderHostedCheckout(checkoutOptions())
		expect(result).toEqual({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_bound',
			sessionId: 'cs_bound',
			processor: 'connect',
		})
		expect(commerce.createCheckout).not.toHaveBeenCalled()
		expect(regional.bindRestaurantOrderPaymentSession).not.toHaveBeenCalled()
	})

	it('rejects replayed Checkout.com sessions it cannot re-serve, retryably', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 's_1', processor: 'checkout' },
			}),
		)
		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 409 })
		expect(await (response as Response).json()).toEqual({
			error: 'session_in_progress',
			retryable: true,
		})
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('never confirms or re-serves a bound session that does not match the order', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_other', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({
				id: 'cs_other',
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_2',
					orderId: 'ord_2',
				},
			}),
		)

		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 409 })
		expect(await (response as Response).json()).toEqual({
			error: 'session_invalid',
			retryable: false,
		})
		expect(regional.notifyRestaurantOrderPaymentStatus).not.toHaveBeenCalled()
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('reports a paid bound session regionally and rejects with already_paid', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'complete', payment_status: 'paid' }),
		)

		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(await (response as Response).json()).toEqual({
			error: 'already_paid',
			retryable: false,
		})
		expect(regional.notifyRestaurantOrderPaymentStatus).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: ORG_ID,
			orderId: ORDER_ID,
			sessionId: 'cs_bound',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('reports a failed bound session regionally and never re-serves it', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		// Async payment failure: the session object itself is unpaid; Stripe's
		// async_payment_failed webhook reports the failure (terminal only via
		// the event). The session retrieval here must reconcile a terminal
		// provider state without re-serving a dead session.
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'expired', payment_status: 'unpaid' }),
		)

		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(await (response as Response).json()).toEqual({
			error: 'session_expired',
			retryable: true,
		})
		expect(regional.notifyRestaurantOrderPaymentStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'expired' }),
		)
		expect(commerce.createCheckout).not.toHaveBeenCalled()
	})

	it('reports an expired bound session regionally and rejects retryably', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'expired', url: null }),
		)

		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(await (response as Response).json()).toEqual({
			error: 'session_expired',
			retryable: true,
		})
		expect(regional.notifyRestaurantOrderPaymentStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'expired' }),
		)
	})

	it('loses a bind race gracefully by recovering the winner and closing its orphan', async () => {
		regional.bindRestaurantOrderPaymentSession.mockRejectedValueOnce(
			new RegionalOrderApiError('already_bound', 409),
		)
		regional.fetchRestaurantOrderQuote
			.mockResolvedValueOnce(quote())
			.mockResolvedValueOnce(
				quote({
					boundSession: { sessionId: 'cs_bound', processor: 'connect' },
				}),
			)

		const result = await createRestaurantOrderHostedCheckout(checkoutOptions())
		expect(result).toEqual({
			checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_bound',
			sessionId: 'cs_bound',
			processor: 'connect',
		})
		// The orphaned session this request created is closed.
		expect(commerce.expireConnectCheckoutSession).toHaveBeenCalledWith('cs_new')
	})

	it('closes its session and fails retryably when the regional bind is unreachable', async () => {
		regional.bindRestaurantOrderPaymentSession.mockRejectedValue(
			new RegionalOrderApiError('regional_unreachable', 503),
		)

		const response = await createRestaurantOrderHostedCheckout(
			checkoutOptions(),
		).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 503 })
		expect(commerce.expireConnectCheckoutSession).toHaveBeenCalledWith('cs_new')
	})

	it('resolves organizations from a custom host and 404s unknown orgs', async () => {
		const result = await createRestaurantOrderHostedCheckout({
			host: 'cafe.example.com',
			orderId: ORDER_ID,
			paymentToken: 'tok_1',
		})
		expect(result.processor).toBe('connect')
		expect(findOrg).toHaveBeenCalledTimes(1)

		findOrg.mockResolvedValue(null)
		const response = await createRestaurantOrderHostedCheckout({
			host: 'unknown.example.com',
			orderId: ORDER_ID,
			paymentToken: 'tok_1',
		}).catch((error: unknown) => error as Response)
		expect(response).toMatchObject({ status: 404 })
		expect(await (response as Response).json()).toEqual({
			error: 'organization_not_found',
			retryable: false,
		})
	})
})

describe('restaurant order payment status poll', () => {
	beforeEach(() => {
		resetMockDb()
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		consoleError.mockImplementation(() => {})

		findOrg.mockReset().mockResolvedValue(orgRow())
		regional.fetchRestaurantOrderQuote.mockReset().mockResolvedValue(quote())
		regional.notifyRestaurantOrderPaymentStatus
			.mockReset()
			.mockResolvedValue(undefined)
		commerce.retrieveConnectCheckoutSession
			.mockReset()
			.mockResolvedValue(stripeSession())
		commerce.isProcessorConfigured.mockReset().mockReturnValue(true)
	})

	it('returns the regional status without provider calls when nothing is bound', async () => {
		const result = await getRestaurantOrderPaymentStatus(checkoutOptions())
		expect(result).toEqual({
			paymentStatus: 'pending',
			orderStatus: 'pending',
			holdExpiresAt: quote().holdExpiresAt,
			processor: null,
		})
		expect(commerce.retrieveConnectCheckoutSession).not.toHaveBeenCalled()
		expect(regional.notifyRestaurantOrderPaymentStatus).not.toHaveBeenCalled()
	})

	it('reconciles a paid Stripe session through the regional service', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'complete', payment_status: 'paid' }),
		)

		const result = await getRestaurantOrderPaymentStatus(checkoutOptions())
		expect(result.paymentStatus).toBe('paid')
		expect(regional.notifyRestaurantOrderPaymentStatus).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: ORG_ID,
			orderId: ORDER_ID,
			sessionId: 'cs_bound',
			processor: 'connect',
			status: 'paid',
			amountCents: 4250,
			currency: 'usd',
		})
	})

	it('keeps the last regional state when the reconciliation is transiently rejected', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'complete', payment_status: 'paid' }),
		)
		regional.notifyRestaurantOrderPaymentStatus.mockRejectedValue(
			new RegionalOrderApiError('regional_unreachable', 503),
		)

		const result = await getRestaurantOrderPaymentStatus(checkoutOptions())
		expect(result.paymentStatus).toBe('pending')
	})

	it('reports a dead provider session as failed for the browser poll', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({ status: 'expired', payment_status: 'unpaid' }),
		)

		const result = await getRestaurantOrderPaymentStatus(checkoutOptions())
		expect(result.paymentStatus).toBe('failed')
		expect(regional.notifyRestaurantOrderPaymentStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'expired' }),
		)
	})

	it('does not reconcile a bound session belonging to another org', async () => {
		regional.fetchRestaurantOrderQuote.mockResolvedValue(
			quote({
				boundSession: { sessionId: 'cs_bound', processor: 'connect' },
			}),
		)
		commerce.retrieveConnectCheckoutSession.mockResolvedValue(
			stripeSession({
				metadata: {
					type: 'restaurant_order',
					orgId: 'org_2',
					orderId: ORDER_ID,
				},
				status: 'complete',
				payment_status: 'paid',
			}),
		)

		const result = await getRestaurantOrderPaymentStatus(checkoutOptions())
		expect(result.paymentStatus).toBe('pending')
		expect(regional.notifyRestaurantOrderPaymentStatus).not.toHaveBeenCalled()
	})

	it('rejects invalid payment tokens', async () => {
		regional.fetchRestaurantOrderQuote.mockRejectedValue(
			new RegionalOrderApiError('order_not_found', 404),
		)
		await expect(
			getRestaurantOrderPaymentStatus(checkoutOptions()),
		).rejects.toMatchObject({ status: 404 })
	})
})
