import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db, eq, Organization } from '@repo/database'
import { MOCK_CHECKOUT_WEBHOOK_SECRET } from '@repo/payments/mock'
import {
	customers,
	getTenantDb,
	provisionTenantDb,
	shopOrders,
} from '@repo/tenant-db'
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
	createPublicShopPaymentIntent,
	getPublicShopOrderStatus,
	getShopCommerce,
	handleConnectAccountUpdated,
	listOrganizationShopOrders,
	recordShopOrder,
	recordShopOrderFromCheckoutWebhook,
} from '#app/utils/shop.server.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { getPaymentsEmulator } from './emulator.server.ts'
import { mockOnboardOrganization } from './onboard.server.ts'

// A signed-in site customer, without minting a tenant token.
vi.mock('#app/utils/tenant-customer-auth.server.ts', () => ({
	resolveVerifiedShopCustomer: async (request: Request) => {
		const customerId = request.headers.get('x-test-customer')
		return customerId ? { customerId, customerEmail: null } : null
	},
}))

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

	it('onboarding is refused outside the US', async () => {
		const org = await createOrg('mock-riyadh', 'ksa')
		for (const provider of ['stripe', 'checkout'] as const) {
			expect(
				await mockOnboardOrganization({ orgSlug: org.slug, provider }),
			).toMatchObject({ ok: false, status: 409 })
		}
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
	async function paidStripeOrder(slug: string) {
		const org = await createOrg(slug, 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' })
		const { session } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		await getPaymentsEmulator().testing.completeCheckout(session.id)
		const tenantDb = await getTenantDb(org.id)
		const [order] = await tenantDb.select().from(shopOrders)
		expect(order).toMatchObject({ status: 'paid' })
		return { org, session, order: order! }
	}

	it('records a full Stripe refund, and a later "paid" never undoes it', async () => {
		const { org, session, order } = await paidStripeOrder('mock-refund')
		const stripe = getShopCommerce().getPlatformStripe()
		// A partial refund leaves the order paid.
		await stripe.refunds.create({
			payment_intent: order.stripePaymentIntentId!,
			amount: 500,
		})
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe('paid')
		await stripe.refunds.create({
			payment_intent: order.stripePaymentIntentId!,
		})
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
		// The success page polls the (still succeeded) payment afterwards.
		await getPublicShopOrderStatus({ slug: org.slug, sessionId: session.id })
		await getPublicShopOrderStatus({
			slug: org.slug,
			paymentIntentId: order.stripePaymentIntentId,
		})
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
	})

	it('records a lost dispute as refunded, and a won one as paid', async () => {
		const { org, session, order } = await paidStripeOrder('mock-dispute')
		const emulator = getPaymentsEmulator()
		const won = (await emulator.testing.createDispute(
			order.stripePaymentIntentId!,
		)) as { id: string }
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'disputed',
		)
		// The success page polls the (still succeeded) payment: a late "paid"
		// does not clear the open dispute.
		await getPublicShopOrderStatus({ slug: org.slug, sessionId: session.id })
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'disputed',
		)
		await emulator.testing.closeDispute(won.id, 'won')
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe('paid')
		const lost = (await emulator.testing.createDispute(
			order.stripePaymentIntentId!,
		)) as { id: string }
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'disputed',
		)
		await emulator.testing.closeDispute(lost.id, 'lost')
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
		await getPublicShopOrderStatus({ slug: org.slug, sessionId: session.id })
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
	})

	it('records a full Checkout.com refund, not a partial one', async () => {
		const org = await createOrg('mock-cko-refund', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'checkout' })
		const { session } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		const emulator = getPaymentsEmulator()
		const { paymentId } = (await emulator.testing.completeHostedPayment(
			session.id,
		)) as { paymentId: string }
		const checkout = (
			getShopCommerce() as unknown as {
				getCheckoutShop(): {
					payments: { refund(id: string, body: object): Promise<unknown> }
				}
			}
		).getCheckoutShop()
		await checkout.payments.refund(paymentId, { amount: 500 })
		await emulator.testing.advanceClock(5)
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe('paid')
		await checkout.payments.refund(paymentId, {})
		await emulator.testing.advanceClock(5)
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
	})

	function signedCheckoutEvent(type: string, data: unknown) {
		const payload = JSON.stringify({ type, data })
		const signature = createHmac('sha256', MOCK_CHECKOUT_WEBHOOK_SECRET)
			.update(payload)
			.digest('hex')
		return recordShopOrderFromCheckoutWebhook(payload, signature)
	}

	it('a late Checkout.com payment_approved never undoes a refund', async () => {
		const org = await createOrg('mock-cko-stale', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'checkout' })
		const { session } = await createPublicShopCheckoutSession({
			request: request(),
			slug: org.slug,
		})
		const emulator = getPaymentsEmulator()
		const { paymentId } = (await emulator.testing.completeHostedPayment(
			session.id,
		)) as { paymentId: string }
		const checkout = (
			getShopCommerce() as unknown as {
				getCheckoutShop(): {
					payments: {
						get(id: string): Promise<Record<string, unknown>>
						refund(id: string, body: object): Promise<unknown>
					}
				}
			}
		).getCheckoutShop()
		// The payment as it looked when it was approved.
		const approved = await checkout.payments.get(paymentId)
		await checkout.payments.refund(paymentId, {})
		await emulator.testing.advanceClock(5)
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)

		await signedCheckoutEvent('payment_approved', approved)
		await signedCheckoutEvent('payment_captured', approved)
		expect((await listOrganizationShopOrders(org.id))[0]?.status).toBe(
			'refunded',
		)
	})

	it('records nothing for a Checkout.com adjustment without a payment id', async () => {
		const org = await createOrg('mock-cko-noid', 'us')
		const commerce = getShopCommerce()
		vi.spyOn(commerce, 'verifyCheckoutWebhook').mockReturnValue({
			type: 'payment_refunded',
			data: {},
		})
		const getOrderStatus = vi.spyOn(commerce, 'getOrderStatus')
		vi.spyOn(commerce, 'parseCheckoutWebhookEvent').mockReturnValue({
			type: 'adjustment',
			order: {
				orgId: org.id,
				customerIdFromMetadata: null,
				productName: 'Starter pack',
				amountCents: 2500,
				platformFeeCents: 0,
				orgPayoutCents: 2500,
				currency: 'usd',
				processor: 'checkout',
				processorCheckoutId: 'ps_noid',
				processorPaymentId: null,
				processorOrderId: null,
				status: 'refunded',
			},
		} as never)
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			expect(
				await recordShopOrderFromCheckoutWebhook('{}', 'signature'),
			).toBeNull()
			expect(getOrderStatus).not.toHaveBeenCalled()
			expect(await listOrganizationShopOrders(org.id)).toHaveLength(0)
			expect(consoleWarn).toHaveBeenCalledWith(
				expect.stringContaining('no payment id'),
			)
		} finally {
			vi.restoreAllMocks()
		}
	})

	it('joins a polled order to the webhook that brings its other id', async () => {
		const org = await createOrg('mock-ids', 'us')
		const order = {
			orgId: org.id,
			customerIdFromMetadata: null,
			productName: 'Starter pack',
			amountCents: 2500,
			platformFeeCents: 500,
			orgPayoutCents: 2000,
			currency: 'usd',
			processorOrderId: null,
			status: 'paid' as const,
		}
		// Checkout.com: the status poll knows only the payment id.
		await recordShopOrder({
			...order,
			processor: 'checkout',
			processorCheckoutId: null,
			processorPaymentId: 'pay_poll',
		})
		await recordShopOrder({
			...order,
			processor: 'checkout',
			processorCheckoutId: 'hpp_poll',
			processorPaymentId: 'pay_poll',
		})
		// Polar: an order event without its checkout, then one with it.
		await recordShopOrder({
			...order,
			processor: 'mor',
			processorCheckoutId: null,
			processorPaymentId: null,
			processorOrderId: 'polar_order_1',
		})
		await recordShopOrder({
			...order,
			processor: 'mor',
			processorCheckoutId: 'polar_checkout_1',
			processorPaymentId: null,
			processorOrderId: 'polar_order_1',
		})
		const rows = await (await getTenantDb(org.id)).select().from(shopOrders)
		expect(rows).toHaveLength(2)
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					checkoutSessionId: 'hpp_poll',
					checkoutPaymentId: 'pay_poll',
				}),
				expect.objectContaining({
					polarCheckoutId: 'polar_checkout_1',
					polarOrderId: 'polar_order_1',
				}),
			]),
		)
	})

	it('a stale account.updated cannot turn charges off', async () => {
		const org = await createOrg('mock-stale-account', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' })
		const [onboarded] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, org.id))
		expect(onboarded?.stripeConnectChargesEnabled).toBe(true)
		// A retried delivery from before onboarding finished.
		await handleConnectAccountUpdated({
			id: onboarded!.stripeConnectAccountId,
			object: 'account',
			metadata: { organizationId: org.id },
			charges_enabled: false,
			payouts_enabled: false,
		})
		const [after] = await db
			.select()
			.from(Organization)
			.where(eq(Organization.id, org.id))
		expect(after).toMatchObject({
			stripeConnectChargesEnabled: true,
			stripeConnectPayoutsEnabled: true,
		})
	})

	it('creates one platform Stripe customer per site customer, however many checkouts race', async () => {
		const org = await createOrg('mock-one-customer', 'us')
		await mockOnboardOrganization({ orgSlug: org.slug, provider: 'stripe' })
		const tenantDb = await getTenantDb(org.id)
		const [customer] = await tenantDb
			.insert(customers)
			.values({ name: 'Sam Rivera', email: 'sam@example.test' })
			.returning()
		const signedIn = () =>
			new Request('http://localhost:3001/api/shop/intent', {
				headers: { 'x-test-customer': customer!.id },
			})
		const intents = await Promise.all([
			createPublicShopPaymentIntent({ request: signedIn(), slug: org.slug }),
			createPublicShopPaymentIntent({ request: signedIn(), slug: org.slug }),
		])
		const [stored] = await tenantDb
			.select({ stripeCustomerId: customers.stripeCustomerId })
			.from(customers)
		const stripe = getShopCommerce().getPlatformStripe()
		for (const intent of intents) {
			const paymentIntent = await stripe.paymentIntents.retrieve(
				intent.paymentIntentId,
			)
			expect(paymentIntent.customer).toBe(stored!.stripeCustomerId)
		}
	})
})
