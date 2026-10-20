import { Checkout } from 'checkout-sdk-node'
import Stripe from 'stripe'
import { createFakeClock } from './clock'
import { type WebhookDelivery } from './context'
import { createPaymentsEmulator, type EmulatorOptions } from './emulator'
import {
	MOCK_CHECKOUT_HOST,
	MOCK_CHECKOUT_PUBLIC_KEY,
	MOCK_CHECKOUT_SECRET_KEY,
	MOCK_CHECKOUT_WEBHOOK_SECRET,
	MOCK_STRIPE_SECRET_KEY,
	MOCK_STRIPE_WEBHOOK_SECRET,
} from './env'
import { createMemoryStore } from './store'
import {
	createMockStripeHttpClient,
	installCheckoutComMockFetch,
} from './transport'
import { hmacSha256Hex } from './util'

export type RecordedDelivery = WebhookDelivery & { status: number }

/** Emulator on a memory store and a fake clock, with real SDK clients on it. */
export function createTestHarness(
	options: Partial<EmulatorOptions> & { respondWith?: number } = {},
) {
	const clock = createFakeClock()
	const deliveries: RecordedDelivery[] = []
	const logs: string[] = []
	const emulator = createPaymentsEmulator({
		store: createMemoryStore(),
		clock,
		origin: 'http://localhost:3001',
		transport: async (delivery) => {
			const status = options.respondWith ?? 200
			deliveries.push({ ...delivery, status })
			return status
		},
		log: (message) => logs.push(message),
		...options,
	})
	const stripe = new Stripe(MOCK_STRIPE_SECRET_KEY, {
		apiVersion: '2025-08-27.basil',
		httpClient: createMockStripeHttpClient(emulator),
		maxNetworkRetries: 0,
	})
	installCheckoutComMockFetch(emulator)
	const checkout = new Checkout(MOCK_CHECKOUT_SECRET_KEY, {
		pk: MOCK_CHECKOUT_PUBLIC_KEY,
		subdomain: 'mock',
		host: MOCK_CHECKOUT_HOST,
	})
	return { emulator, stripe, checkout, clock, deliveries, logs }
}

export type Harness = ReturnType<typeof createTestHarness>

export async function onboardedAccount(harness: Harness) {
	const account = await harness.stripe.accounts.create({
		type: 'express',
		country: 'US',
		capabilities: {
			card_payments: { requested: true },
			transfers: { requested: true },
		},
		metadata: { organizationId: 'org_test', organizationName: 'Acme Test' },
	})
	await harness.emulator.testing.completeOnboarding(account.id, 'complete')
	return account.id
}

export async function activeEntity(harness: Harness, reference = 'org_test') {
	const entity = (await harness.checkout.platforms.onboardSubEntity({
		reference,
		contact_details: { invitee: { email: 'owner@example.test' } },
		is_draft: true,
	} as never)) as { id: string }
	await harness.emulator.testing.activateEntity(entity.id)
	return entity.id
}

/** Checks a recorded Stripe delivery with the real SDK verification. */
export function verifyStripeDelivery(
	delivery: WebhookDelivery,
	secret = MOCK_STRIPE_WEBHOOK_SECRET,
) {
	return Stripe.webhooks.constructEvent(
		delivery.body,
		delivery.headers['stripe-signature']!,
		secret,
	)
}

export async function checkoutSignatureValid(
	delivery: WebhookDelivery,
	secret = MOCK_CHECKOUT_WEBHOOK_SECRET,
) {
	return (
		delivery.headers['cko-signature'] ===
		(await hmacSha256Hex(secret, delivery.body))
	)
}
