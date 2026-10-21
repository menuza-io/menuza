import { db, eq, Organization } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createRestaurantOrderHostedCheckout,
	getRestaurantOrderPaymentStatus,
} from '#app/utils/restaurant-orders/checkout.server.ts'
import type * as RegionalApi from '#app/utils/restaurant-orders/regional-order-api.server.ts'
import { configureShopCommerceForTests } from '#app/utils/shop.server.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { getPaymentsEmulator } from './emulator.server.ts'
import { mockOnboardOrganization } from './onboard.server.ts'

const regional = vi.hoisted(() => ({
	order: {
		total: 2500,
		currency: 'USD',
		bound: null as null | {
			sessionId: string
			processor: 'connect' | 'checkout'
		},
		paymentStatus: 'pending',
	},
	notify: vi.fn(),
}))

vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalApi>()
		return {
			...actual,
			fetchRestaurantOrderQuote: vi.fn(
				async (input: { orgId: string; orderId: string }) => ({
					orgId: input.orgId,
					orderId: input.orderId,
					totalCents: regional.order.total,
					currency: regional.order.currency,
					holdExpiresAt: null,
					status: 'pending',
					paymentStatus: regional.order.paymentStatus,
					boundSession: regional.order.bound,
				}),
			),
			bindRestaurantOrderPaymentSession: vi.fn(
				async (input: {
					sessionId: string
					processor: 'connect' | 'checkout'
				}) => {
					regional.order.bound = {
						sessionId: input.sessionId,
						processor: input.processor,
					}
				},
			),
			notifyRestaurantOrderPaymentStatus: vi.fn(
				async (input: { status: string }) => {
					regional.notify(input)
					if (input.status === 'paid' || input.status === 'failed')
						regional.order.paymentStatus = input.status
				},
			),
		}
	},
)

const env = {
	MOCKS: 'true',
	STRIPE_SECRET_KEY: 'sk_test_***',
	CHECKOUT_SECRET_KEY: '',
	CHECKOUT_WEBHOOK_SECRET: '',
}

async function createOrg(slug: string, dataRegion: 'us' | 'ksa') {
	await db.delete(Organization).where(eq(Organization.slug, slug))
	const [org] = await db
		.insert(Organization)
		.values({
			name: `Mock ${slug}`,
			slug,
			dataRegion,
			sitePublished: true,
			active: true,
		})
		.returning()
	return org!
}

const checkoutOptions = (slug: string) => ({
	slug,
	orderId: 'ord_1',
	paymentToken: 'tok',
	locale: 'en',
})

describe('existing orders on the payment mock', () => {
	beforeEach(async () => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', '')
		regional.order = {
			total: 2500,
			currency: 'USD',
			bound: null,
			paymentStatus: 'pending',
		}
		regional.notify.mockReset()
		configureShopCommerceForTests(process.env)
		await getPaymentsEmulator().reset()
	})
	afterEach(() => vi.unstubAllEnvs())

	it('a US Stripe order pays: inline webhook marks it paid, signature verified by the real route', async () => {
		const org = await createOrg('mock-acme', 'us')
		await expect(
			createRestaurantOrderHostedCheckout(checkoutOptions(org.slug)),
		).rejects.toMatchObject({ status: 409 })
		expect(
			await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' }),
		).toMatchObject({ ok: true })
		const [onboarded] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, org.id))
		expect(onboarded).toMatchObject({
			stripeConnectChargesEnabled: true,
			shopPaymentProvider: 'stripe',
		})

		const checkout = await createRestaurantOrderHostedCheckout(
			checkoutOptions(org.slug),
		)
		expect(checkout.processor).toBe('connect')
		expect(checkout.checkoutUrl).toContain(
			'/mock-payments/stripe/checkout/cs_test_',
		)
		const emulator = getPaymentsEmulator()
		const result = await emulator.testing.completeCheckout(checkout.sessionId)
		expect(result.status).toBe('paid')
		expect(regional.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				processor: 'connect',
				status: 'paid',
				amountCents: 2500,
				currency: 'usd',
			}),
		)
		const events = await emulator.events.list({
			provider: 'stripe',
			type: 'checkout.session.completed',
		})
		expect(events[0]).toMatchObject({
			deliveredAt: expect.any(Number),
			lastStatus: 200,
		})
	})

	it('manual webhooks: the poll reconciles through the provider, a late webhook is idempotent', async () => {
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
		const org = await createOrg('mock-acme-2', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' })
		const checkout = await createRestaurantOrderHostedCheckout(
			checkoutOptions(org.slug),
		)
		await getPaymentsEmulator().testing.completeCheckout(checkout.sessionId)
		expect(regional.notify).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'paid' }),
		)
		const status = await getRestaurantOrderPaymentStatus({
			slug: org.slug,
			orderId: 'ord_1',
			paymentToken: 'tok',
		})
		expect(status.paymentStatus).toBe('paid')
		const flush = await getPaymentsEmulator().events.flush()
		expect(flush.delivered).toBeGreaterThan(0)
		expect(regional.order.paymentStatus).toBe('paid')
	})

	it('a KSA Checkout.com order pays through the hosted page and is confirmed with no webhook', async () => {
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
		regional.order.currency = 'SAR'
		regional.order.total = 12_000
		const org = await createOrg('mock-riyadh', 'ksa')
		expect(
			await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' }),
		).toMatchObject({ ok: false, status: 409 })
		expect(
			await mockOnboardOrganization({
				orgSlug: org.slug,
				provider: 'checkout',
			}),
		).toMatchObject({ ok: true })
		const [onboarded] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, org.id))
		expect(onboarded).toMatchObject({
			checkoutChargesEnabled: true,
			shopPaymentProvider: 'checkout',
		})

		const checkout = await createRestaurantOrderHostedCheckout({
			...checkoutOptions(org.slug),
			locale: 'ar',
		})
		expect(checkout.processor).toBe('checkout')
		expect(checkout.checkoutUrl).toContain(
			'/mock-payments/checkout-com/hpp/hpp_',
		)
		expect(regional.order.bound).toEqual({
			sessionId: `restaurant_order:${org.id}:ord_1`,
			processor: 'checkout',
		})

		const emulator = getPaymentsEmulator()
		await emulator.testing.completeHostedPayment(checkout.sessionId)
		const status = await getRestaurantOrderPaymentStatus({
			slug: org.slug,
			orderId: 'ord_1',
			paymentToken: 'tok',
		})
		expect(status.paymentStatus).toBe('paid')
		expect(regional.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				processor: 'checkout',
				status: 'paid',
				amountCents: 12_000,
				currency: 'sar',
			}),
		)
		// The late webhook is accepted by the real route and changes nothing.
		const flush = await emulator.events.flush({ provider: 'checkout' })
		expect(flush.delivered).toBe(2)
		expect(
			(await emulator.events.list({ provider: 'checkout' })).every(
				(event) => event.lastStatus === 200,
			),
		).toBe(true)
		expect(regional.order.paymentStatus).toBe('paid')
	})

	it('an amount-based decline is reported failed and never paid', async () => {
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
		regional.order.currency = 'SAR'
		regional.order.total = 1005
		const org = await createOrg('mock-riyadh-2', 'ksa')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'checkout' })
		const checkout = await createRestaurantOrderHostedCheckout(
			checkoutOptions(org.slug),
		)
		await getPaymentsEmulator().testing.completeHostedPayment(
			checkout.sessionId,
		)
		const status = await getRestaurantOrderPaymentStatus({
			slug: org.slug,
			orderId: 'ord_1',
			paymentToken: 'tok',
		})
		expect(status.paymentStatus).toBe('failed')
		expect(regional.notify).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'paid' }),
		)
	})

	it('forged webhooks are rejected by the real routes', async () => {
		consoleError.mockImplementation(() => {})
		const stripeRoute = await import('#app/routes/api+/stripe+/webhook.tsx')
		const shopRoute = await import('#app/routes/api+/shop+/webhook.tsx')
		const body = JSON.stringify({
			id: 'evt_x',
			type: 'checkout.session.completed',
			data: { object: {} },
		})
		const stripe = await stripeRoute.action({
			request: new Request('http://localhost:3001/api/stripe/webhook', {
				method: 'POST',
				headers: { 'stripe-signature': 't=1,v1=forged' },
				body,
			}),
			params: {},
			context: {},
		} as never)
		expect(stripe.status).toBe(400)
		const checkout = await shopRoute.action({
			request: new Request('http://localhost:3001/api/shop/webhook', {
				method: 'POST',
				headers: { 'cko-signature': 'deadbeef' },
				body: JSON.stringify({ type: 'payment_approved', data: {} }),
			}),
			params: {},
			context: {},
		} as never)
		expect(checkout.status).toBe(400)
		expect(regional.notify).not.toHaveBeenCalled()
	})
})
