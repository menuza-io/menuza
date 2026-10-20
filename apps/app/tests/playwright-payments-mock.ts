import { type APIRequestContext, type Page, expect } from '@playwright/test'

/**
 * Playwright helpers for the local payment mock (see docs/payments-mock.md).
 *
 * - `PaymentsMockApi` drives the JSON dev API (`/mock-payments/dev/*`): setup,
 *   the clock, flush, and assertions on provider objects. Specs assert through
 *   it (and through App or Sites status endpoints), never on a redirect alone.
 * - The page objects key on `data-testid`, so wording and layout can change.
 * - `createMockProviders` builds the real Stripe and Checkout.com SDK clients on
 *   the same database the App server reads. It is how a spec starts a hosted
 *   session without the regional services. It works wherever the spec process
 *   and the App share one database (the CI Node server and local LibSQL runs);
 *   against Workers dev, which keeps its state in D1, use the dev API and the
 *   real order flow instead.
 */

type Json = Record<string, any>

export class PaymentsMockApi {
	constructor(
		private readonly request: APIRequestContext,
		private readonly baseURL: string,
	) {}

	private url(path: string) {
		return new URL(`/mock-payments/dev/${path}`, this.baseURL).toString()
	}

	private async post(path: string, data: unknown = {}) {
		return this.request.post(this.url(path), { data })
	}

	async reset() {
		const response = await this.post('reset')
		expect(response.status()).toBe(200)
	}

	async onboard(orgSlug: string, provider: 'stripe' | 'checkout') {
		return this.post('onboard', { orgSlug, provider })
	}

	async completeStripeSession(
		sessionId: string,
		body: { card?: string; email?: string; threeDS?: 'complete' | 'fail' } = {},
	) {
		return this.post(`stripe/sessions/${sessionId}/complete`, body)
	}

	async completeHostedPayment(
		hppId: string,
		body: { card?: string; password?: string; email?: string } = {},
	) {
		return this.post(`checkout-com/hpp/${hppId}/complete`, body)
	}

	async expireSession(sessionId: string) {
		return this.post(`sessions/${sessionId}/expire`)
	}

	async settleRefund(id: string, outcome?: string) {
		return this.post(`refunds/${id}/settle`, outcome ? { outcome } : {})
	}

	async createDispute(paymentIntent: string) {
		return this.post('disputes', { paymentIntent })
	}

	async advanceClock(seconds: number) {
		const response = await this.post('clock/advance', { seconds })
		expect(response.status()).toBe(200)
	}

	async flush() {
		const response = await this.post('events/flush')
		expect(response.status()).toBe(200)
		return (await response.json()) as { attempted: number; delivered: number }
	}

	async redeliver(eventId: string) {
		return this.post(`events/${eventId}/redeliver`)
	}

	async events(filter: { provider?: string; type?: string } = {}) {
		const query = new URLSearchParams(
			Object.entries(filter).filter(([, value]) => value) as [string, string][],
		)
		const response = await this.request.get(this.url(`events?${query}`))
		expect(response.status()).toBe(200)
		return (await response.json()) as Array<{
			id: string
			provider: string
			type: string
			delivered_at: string | null
			attempts: number
			last_status: number | null
		}>
	}

	async object(provider: 'stripe' | 'checkout', id: string): Promise<Json> {
		const response = await this.request.get(
			this.url(`objects/${provider}/${id}`),
		)
		expect(response.status()).toBe(200)
		return (await response.json()) as Json
	}
}

export function sessionIdFromUrl(url: string) {
	return new URL(url).pathname.split('/').pop()!
}

async function fillCard(
	page: Page,
	card: {
		number: string
		expiry?: string
		cvc?: string
		email?: string
		name?: string
	},
) {
	if (card.email) await page.getByTestId('mock-card-email').fill(card.email)
	await page.getByTestId('mock-card-number').fill(card.number)
	await page.getByTestId('mock-card-expiry').fill(card.expiry ?? '12/34')
	await page.getByTestId('mock-card-cvc').fill(card.cvc ?? '123')
	if (card.name) await page.getByTestId('mock-card-name').fill(card.name)
}

export class MockStripeCheckoutPage {
	constructor(private readonly page: Page) {}

	async open(url: string) {
		await this.page.goto(url)
		await expect(this.page.getByTestId('mock-banner')).toBeVisible()
	}

	async pay(
		number: string,
		extra: { email?: string; expiry?: string; cvc?: string } = {},
	) {
		await fillCard(this.page, { number, ...extra })
		await this.page.getByTestId('mock-pay-button').click()
	}

	async back() {
		await this.page.getByTestId('mock-back-link').click()
	}

	error() {
		return this.page.getByTestId('mock-error')
	}

	inactive() {
		return this.page.getByTestId('mock-session-inactive')
	}

	amount() {
		return this.page.getByTestId('mock-amount')
	}
}

export class MockStripeThreeDSPage {
	constructor(private readonly page: Page) {}

	async complete() {
		await this.page.getByTestId('mock-3ds-complete').click()
	}

	async fail() {
		await this.page.getByTestId('mock-3ds-fail').click()
	}
}

export class MockConnectOnboardingPage {
	constructor(private readonly page: Page) {}

	async complete() {
		await this.page.getByTestId('mock-onboard-complete').click()
	}

	async submitWithRequirementsDue() {
		await this.page.getByTestId('mock-onboard-requirements').click()
	}

	async payoutsRestricted() {
		await this.page.getByTestId('mock-onboard-payouts').click()
	}
}

export class MockCheckoutHppPage {
	constructor(private readonly page: Page) {}

	async open(url: string) {
		await this.page.goto(url)
		await expect(this.page.getByTestId('mock-banner')).toBeVisible()
	}

	async pay(number: string, extra: { email?: string } = {}) {
		await fillCard(this.page, { number, ...extra })
		await this.page.getByTestId('mock-pay-button').click()
	}

	async back() {
		await this.page.getByTestId('mock-back-link').click()
	}
}

export class MockCheckoutThreeDSPage {
	constructor(private readonly page: Page) {}

	async submit(password: string) {
		await this.page.getByTestId('mock-3ds-password').fill(password)
		await this.page.getByTestId('mock-3ds-submit').click()
	}
}

export class MockPaymentsDashboardPage {
	constructor(private readonly page: Page) {}

	async open() {
		await this.page.goto('/mock-payments/dashboard')
		await expect(this.page.getByTestId('mock-banner')).toBeVisible()
	}

	eventRow(eventId: string) {
		return this.page.locator(
			`[data-testid="mock-event-row"][data-event-id="${eventId}"]`,
		)
	}

	async redeliver(eventId: string) {
		await this.eventRow(eventId).getByTestId('mock-redeliver').click()
	}
}

/**
 * Real SDK clients on the App's database, for starting hosted sessions in a
 * spec. Webhooks stay with the App server: this emulator only records events
 * it never delivers (no transport), so nothing is delivered twice.
 */
export async function createMockProviders(baseURL: string) {
	const [
		{ default: Stripe },
		{ Checkout },
		mock,
		{ createSqlMockStore },
		{ createStoreClock },
	] = await Promise.all([
		import('stripe'),
		import('checkout-sdk-node'),
		import('@repo/payments/mock'),
		import('#app/utils/payments-mock/store.server.ts'),
		import('#app/utils/payments-mock/emulator.server.ts'),
	])
	const store = createSqlMockStore()
	const emulator = mock.createPaymentsEmulator({
		store,
		clock: createStoreClock(store),
		origin: new URL(baseURL).origin,
		webhookMode: 'manual',
	})
	mock.installCheckoutComMockFetch(emulator)
	const stripe = new Stripe(mock.MOCK_STRIPE_SECRET_KEY, {
		apiVersion: '2025-08-27.basil',
		httpClient: mock.createMockStripeHttpClient(emulator),
		maxNetworkRetries: 0,
	})
	const checkout = new Checkout(mock.MOCK_CHECKOUT_SECRET_KEY, {
		pk: mock.MOCK_CHECKOUT_PUBLIC_KEY,
		subdomain: mock.MOCK_CHECKOUT_SUBDOMAIN,
		host: mock.MOCK_CHECKOUT_HOST,
	})
	return { stripe, checkout, emulator }
}
