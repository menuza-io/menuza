import {
	createMockStripeHttpClient,
	MOCK_STRIPE_SECRET_KEY,
} from '@repo/payments/mock'
import { RouterContextProvider } from 'react-router'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getPaymentsEmulator,
	resetPaymentsEmulatorSingleton,
} from '#app/utils/payments-mock/emulator.server.ts'
import { action as checkoutAction } from './stripe.checkout.$sessionId.tsx'

/**
 * The hosted Stripe checkout the Playwright spec drives, without a browser:
 * the page's POST goes through the real route action, the real emulator on the
 * test database and, inline, the real webhook route. What the spec asserts
 * after paying (a redirect to the session's success URL, a complete and paid
 * session, a delivered `checkout.session.completed`) is asserted here.
 */
const ORIGIN = 'http://localhost:3101'
const SUCCESS_URL = `${ORIGIN}/mock-payments/dashboard?paid=1`

function formRequest(sessionId: string, fields: Record<string, string>) {
	// A native form post, as `<Form reloadDocument>` sends it.
	return new Request(`${ORIGIN}/mock-payments/stripe/checkout/${sessionId}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: ORIGIN,
		},
		body: new URLSearchParams(fields).toString(),
	})
}

async function settle(run: () => unknown) {
	try {
		return (await run()) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

describe('hosted Stripe checkout through the route action', () => {
	beforeEach(() => {
		vi.stubEnv('MOCKS', 'true')
		vi.stubEnv('PAYMENTS_MOCK', '')
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'inline')
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS_HTTP', '')
		vi.stubEnv('BASE_URL', ORIGIN)
		vi.stubEnv('PAYMENTS_MOCK_ORIGIN', ORIGIN)
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_***')
		vi.stubEnv('CHECKOUT_SECRET_KEY', '')
		resetPaymentsEmulatorSingleton()
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		resetPaymentsEmulatorSingleton()
	})

	async function startSession() {
		const emulator = getPaymentsEmulator(process.env)
		const stripe = new Stripe(MOCK_STRIPE_SECRET_KEY, {
			apiVersion: '2025-08-27.basil',
			httpClient: createMockStripeHttpClient(emulator),
			maxNetworkRetries: 0,
		})
		const account = await stripe.accounts.create({
			type: 'express',
			country: 'US',
			capabilities: {
				card_payments: { requested: true },
				transfers: { requested: true },
			},
			metadata: { organizationId: 'org_e2e', organizationName: 'E2E Org' },
		})
		await emulator.testing.completeOnboarding(account.id, 'complete')
		const session = await stripe.checkout.sessions.create({
			mode: 'payment',
			line_items: [
				{
					price_data: {
						currency: 'usd',
						product_data: { name: 'Mock order' },
						unit_amount: 2500,
					},
					quantity: 1,
				},
			],
			payment_intent_data: {
				application_fee_amount: 500,
				transfer_data: { destination: account.id },
				metadata: { type: 'e2e' },
			},
			success_url: SUCCESS_URL,
			cancel_url: `${ORIGIN}/mock-payments/dashboard?cancelled=1`,
			metadata: { type: 'e2e' },
		})
		return { emulator, session }
	}

	it('a 4242 card redirects to the success URL, completes the session and delivers the webhook', async () => {
		const { emulator, session } = await startSession()
		expect(session.url).toContain(ORIGIN)
		const response = await settle(() =>
			checkoutAction({
				request: formRequest(session.id, {
					email: '',
					number: '4242 4242 4242 4242',
					expiry: '12/34',
					cvc: '123',
					name: '',
					postalCode: '94103',
				}),
				params: { sessionId: session.id },
				context: new RouterContextProvider(),
				unstable_pattern: '/x',
			} as never),
		)
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(SUCCESS_URL)

		const stored = await emulator.object('stripe', session.id)
		expect(stored).toMatchObject({
			status: 'complete',
			payment_status: 'paid',
		})
		const events = await emulator.events.list({ provider: 'stripe' })
		const completed = events.find(
			(event) => event.type === 'checkout.session.completed',
		)
		expect(completed).toBeTruthy()
		// The webhook route answered 2xx for the event (delivered inline).
		expect(completed?.lastStatus).toBe(200)
	})
})
