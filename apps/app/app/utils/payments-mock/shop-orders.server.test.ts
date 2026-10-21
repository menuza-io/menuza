import fs from 'node:fs'
import path from 'node:path'
import { db, eq, Organization } from '@repo/database'
import { provisionTenantDb } from '@repo/tenant-db'
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	configureShopCommerceForTests,
	createPublicShopCheckoutSession,
	listOrganizationShopOrders,
} from '#app/utils/shop.server.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { getPaymentsEmulator } from './emulator.server.ts'
import { mockOnboardOrganization } from './onboard.server.ts'

const tenantDir = vi.hoisted(() => {
	// The tenant database reads its directory when the connection opens.
	const dir = `${process.env.TMPDIR ?? '/tmp'}/payments-mock-tenant-${process.pid}`
	process.env.TENANT_DB_DIR = dir
	return dir
})

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
			shopEnabled: true,
			shopProductName: 'Starter pack',
			shopProductPriceCents: 2500,
		})
		.returning()
	await provisionTenantDb(org!.id)
	return org!
}

const request = () => new Request('http://localhost:3001/api/shop/checkout')

describe('shop orders on the payment mock', () => {
	beforeEach(async () => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', '')
		configureShopCommerceForTests(process.env)
		await getPaymentsEmulator().reset()
	})
	afterEach(() => vi.unstubAllEnvs())
	afterAll(() => {
		fs.rmSync(path.resolve(tenantDir), { recursive: true, force: true })
	})

	it('a US Stripe order pays: the inline webhook records it, verified by the real route', async () => {
		const org = await createOrg('mock-acme', 'us')
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

		const { session, processor } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		expect(processor).toBe('connect')
		expect(session.url).toContain('/mock-payments/stripe/checkout/cs_test_')

		const emulator = getPaymentsEmulator()
		const result = await emulator.testing.completeCheckout(session.id)
		expect(result.status).toBe('paid')

		const orders = await listOrganizationShopOrders(org.id)
		expect(orders).toHaveLength(1)
		expect(orders[0]).toMatchObject({ amountCents: 2500, status: 'paid' })
		const events = await emulator.events.list({
			provider: 'stripe',
			type: 'checkout.session.completed',
		})
		expect(events[0]).toMatchObject({
			deliveredAt: expect.any(Number),
			lastStatus: 200,
		})
	})

	it('manual webhooks hold the order until the events are flushed', async () => {
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
		const org = await createOrg('mock-acme-2', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' })
		const { session } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		const emulator = getPaymentsEmulator()
		await emulator.testing.completeCheckout(session.id)
		expect(await listOrganizationShopOrders(org.id)).toHaveLength(0)

		const flush = await emulator.events.flush()
		expect(flush.delivered).toBeGreaterThan(0)
		expect(await listOrganizationShopOrders(org.id)).toHaveLength(1)
	})

	it('a Checkout.com order pays through the hosted page', async () => {
		const org = await createOrg('mock-acme-3', 'us')
		expect(
			await mockOnboardOrganization({
				orgSlug: org.slug,
				provider: 'checkout',
			}),
		).toMatchObject({ ok: true })
		const { session, processor } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		expect(processor).toBe('checkout')
		expect(session.url).toContain('/mock-payments/checkout-com/hpp/hpp_')

		await getPaymentsEmulator().testing.completeHostedPayment(session.id)
		const orders = await listOrganizationShopOrders(org.id)
		expect(orders).toHaveLength(1)
		expect(orders[0]).toMatchObject({ amountCents: 2500, status: 'paid' })
	})

	it('Stripe onboarding is refused outside the US, Checkout.com is open to every region', async () => {
		const org = await createOrg('mock-riyadh', 'ksa')
		expect(
			await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' }),
		).toMatchObject({ ok: false, status: 409, error: 'stripe_us_only' })
		// KSA organizations take their online payments through Checkout.com.
		expect(
			await mockOnboardOrganization({
				orgSlug: org.slug,
				provider: 'checkout',
			}),
		).toMatchObject({ ok: true })
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
	})
})
