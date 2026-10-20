import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { paymentsMockMode, MOCK_CHECKOUT_HOST } from '../mocks/env'
import {
	createTestHarness,
	activeEntity,
	type Harness,
} from '../mocks/test-helpers'
import { createMockStripeHttpClient } from '../mocks/transport'
import { createShopCommerce } from './commerce'
import { createShopCommerceConfigFromEnv } from './config'
import { applyPaymentsMockConfig } from './mock-config'

function mockCommerce(harness: Harness, env: Record<string, string> = {}) {
	const fullEnv = {
		MOCKS: 'true',
		BASE_URL: 'http://localhost:3001',
		STRIPE_SECRET_KEY: 'sk_test_***',
		STRIPE_PUBLISHABLE_KEY: 'pk_test_***',
		STRIPE_WEBHOOK_SECRET: 'whsec_***',
		...env,
	}
	const config = applyPaymentsMockConfig(
		createShopCommerceConfigFromEnv(fullEnv),
		fullEnv,
		paymentsMockMode(fullEnv),
		{
			stripeHttpClient: createMockStripeHttpClient(harness.emulator),
			checkoutDashboardUrl:
				'http://localhost:3001/mock-payments/checkout-com/dashboard',
		},
	)
	return createShopCommerce(config)
}

describe('ShopCommerce on the payment mock', () => {
	it('placeholder keys leave both processors unconfigured without the mock', () => {
		const config = createShopCommerceConfigFromEnv({
			STRIPE_SECRET_KEY: 'sk_test_***',
			CHECKOUT_SECRET_KEY: '',
		})
		expect(createShopCommerce(config).listConfiguredProcessors()).toEqual([])
	})

	it('MOCKS=true with placeholder keys configures connect and checkout (not hosted MOR)', () => {
		const commerce = mockCommerce(createTestHarness())
		expect(commerce.listConfiguredProcessors()).toEqual(['connect', 'checkout'])
		expect(commerce.getProcessorDashboardUrl('checkout')).toBe(
			'http://localhost:3001/mock-payments/checkout-com/dashboard',
		)
	})

	it('a real Stripe test key keeps that provider real and mocks only the other', () => {
		const harness = createTestHarness()
		const fullEnv = {
			MOCKS: 'true',
			BASE_URL: 'http://localhost:3001',
			STRIPE_SECRET_KEY: 'sk_test_51Real',
			CHECKOUT_SECRET_KEY: '',
		}
		const config = applyPaymentsMockConfig(
			createShopCommerceConfigFromEnv(fullEnv),
			fullEnv,
			paymentsMockMode(fullEnv),
			{
				stripeHttpClient: createMockStripeHttpClient(harness.emulator),
				checkoutDashboardUrl:
					'http://localhost:3001/mock-payments/checkout-com/dashboard',
			},
		)
		expect(config.stripeSecretKey).toBe('sk_test_51Real')
		expect(config.mock?.stripeHttpClient).toBeUndefined()
		expect(config.mock?.checkoutHost).toBe(MOCK_CHECKOUT_HOST)
	})

	it('onboards a Connect account through the commerce helpers', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const account = await commerce.createConnectExpressAccount({
			organizationId: 'org_a',
			organizationName: 'Acme',
		})
		const url = await commerce.createConnectOnboardingLink({
			accountId: account.id,
			refreshUrl: 'http://localhost:3001/acme/settings/shop?connect=refresh',
			returnUrl: 'http://localhost:3001/acme/settings/shop?connect=return',
		})
		expect(url).toContain('/mock-payments/stripe/connect/onboard/')
		expect(
			await commerce.retrieveConnectAccountStatus(account.id),
		).toMatchObject({
			chargesEnabled: false,
		})
		await harness.emulator.testing.completeOnboarding(account.id)
		expect(
			await commerce.retrieveConnectAccountStatus(account.id),
		).toMatchObject({
			chargesEnabled: true,
			payoutsEnabled: true,
		})
		expect(await commerce.createConnectDashboardLink(account.id)).toContain(
			`/mock-payments/stripe/connect/dashboard/${account.id}`,
		)
	})

	it('creates a Connect order session with the 20% shop fee and a hosted page url', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const account = await commerce.createConnectExpressAccount({
			organizationId: 'org_a',
			organizationName: 'Acme',
		})
		await harness.emulator.testing.completeOnboarding(account.id)
		const session = await commerce.createCheckout({
			processor: 'connect',
			productName: 'Shop order',
			amountCents: 5000,
			connectAccountId: account.id,
			successUrl: 'http://localhost:3008/shop/success?order=o1',
			cancelUrl: 'http://localhost:3008/shop',
			metadata: { type: 'shop_order', orgId: 'org_a', orderId: 'o1' },
		})
		expect(session.url).toBe(
			`http://localhost:3001/mock-payments/stripe/checkout/${session.id}`,
		)
		const stored = await commerce.retrieveConnectCheckoutSession(session.id)
		expect(stored).toMatchObject({ amount_total: 5000, status: 'open' })
	})

	it('creates a Checkout.com order on the hosted payments page, not Flow', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const entity = await commerce.inviteCheckoutSubEntity({
			organizationId: 'org_k',
			inviteeEmail: 'owner@example.test',
		})
		expect(
			await commerce.retrieveCheckoutSubEntityStatus(entity.id),
		).toMatchObject({
			chargesEnabled: false,
		})
		await harness.emulator.testing.activateEntity(entity.id)
		expect(
			await commerce.retrieveCheckoutSubEntityStatus(entity.id),
		).toMatchObject({
			chargesEnabled: true,
			payoutsEnabled: true,
		})
		const session = await commerce.createCheckout({
			processor: 'checkout',
			productName: 'Shop order',
			amountCents: 12_000,
			checkoutSubEntityId: entity.id,
			successUrl: 'http://localhost:3008/shop/success?order=o1',
			cancelUrl: 'http://localhost:3008/shop',
			metadata: { type: 'shop_order', orgId: 'org_k', orderId: 'o1' },
		})
		expect(session.id).toMatch(/^hpp_/)
		expect(session.url).toBe(
			`http://localhost:3001/mock-payments/checkout-com/hpp/${session.id}`,
		)
		const hosted = await commerce.retrieveCheckoutHostedPayment(session.id)
		expect(hosted).toMatchObject({
			status: 'Payment Pending',
			paymentId: null,
			reference: 'org_k',
		})

		// No webhook needed: the status is found through the API.
		await harness.emulator.testing.completeHostedPayment(session.id)
		const found = await commerce.findCheckoutPaymentsByReference('org_k')
		expect(found).toHaveLength(1)
		expect(found[0]).toMatchObject({
			paid: true,
			amountCents: 12_000,
			currency: 'usd',
		})
		expect(found[0]?.status).not.toBe('Declined')
	})

	it('verifies the mock Checkout.com webhook signature with the real verifier', async () => {
		const harness = createTestHarness({ webhookMode: 'manual' })
		const commerce = mockCommerce(harness)
		const entity = await activeEntity(harness)
		const session = await commerce.createCheckout({
			processor: 'checkout',
			productName: 'Shop order',
			amountCents: 12_000,
			checkoutSubEntityId: entity,
			successUrl: 'http://localhost:3008/shop/success?order=o1',
			cancelUrl: 'http://localhost:3008/shop',
			metadata: { type: 'shop_order', orgId: 'org_k', orderId: 'o1' },
		})
		await harness.emulator.testing.completeHostedPayment(session.id)
		await harness.emulator.events.flush()
		const delivery = harness.deliveries.find((entry) =>
			entry.body.includes('payment_approved'),
		)!
		const event = commerce.verifyCheckoutWebhook(
			delivery.body,
			delivery.headers['cko-signature']!,
		)
		expect(event.type).toBe('payment_approved')
		expect(commerce.parseCheckoutWebhookEvent(event)).toMatchObject({
			type: 'payment',
			order: { orgId: 'org_k', status: 'paid' },
		})
		expect(() =>
			commerce.verifyCheckoutWebhook(delivery.body, 'deadbeef'),
		).toThrow('signature')
	})
})

describe('withConnect keeps provider errors', () => {
	it('authentication_required survives with its class, code and raw PaymentIntent', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const stripe = (commerce as unknown as { getStripe(): Stripe }).getStripe()
		const customer = await stripe.customers.create({})
		const method = await stripe.paymentMethods.attach(
			'pm_card_authenticationRequired',
			{
				customer: customer.id,
			},
		)
		const account = await commerce.createConnectExpressAccount({
			organizationId: 'org_a',
			organizationName: 'Acme',
		})
		await harness.emulator.testing.completeOnboarding(account.id)
		const charge = (
			commerce as unknown as {
				withConnect<T>(operation: () => Promise<T>): Promise<T>
			}
		).withConnect(() =>
			stripe.paymentIntents.create({
				amount: 5000,
				currency: 'usd',
				customer: customer.id,
				payment_method: method.id,
				off_session: true,
				confirm: true,
				transfer_data: { destination: account.id },
			}),
		)
		const error = await charge.catch((thrown) => thrown)
		expect(error).toBeInstanceOf(Stripe.errors.StripeCardError)
		expect(error).toMatchObject({ code: 'authentication_required' })
		expect(error.raw.payment_intent).toMatchObject({
			status: 'requires_payment_method',
		})
	})

	it('attachPaymentMethodToCustomer now swallows resource_already_exists', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const stripe = (commerce as unknown as { getStripe(): Stripe }).getStripe()
		const customer = await stripe.customers.create({})
		const method = await stripe.paymentMethods.attach('pm_card_visa', {
			customer: customer.id,
		})
		await expect(
			commerce.attachPaymentMethodToCustomer(customer.id, method.id),
		).resolves.toBeUndefined()
	})

	it('still redacts the secret key from messages', async () => {
		const harness = createTestHarness()
		const commerce = mockCommerce(harness)
		const run = (
			commerce as unknown as {
				withConnect<T>(operation: () => Promise<T>): Promise<T>
			}
		).withConnect
		const error = (await run
			.call(commerce, async (): Promise<never> => {
				throw new Error('boom sk_test_mock_platform leaked')
			})
			.catch((thrown: unknown) => thrown)) as Error
		expect(error.message).toBe('boom [redacted] leaked')
	})
})
