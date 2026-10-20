import { type MockClock } from './clock'
import { type MockWebhookMode } from './env'
import { type MockProvider, type MockStore } from './store'

export type WebhookDelivery = {
	provider: MockProvider
	/** Route path on the App: `/api/stripe/webhook` or `/api/shop/webhook`. */
	path: string
	headers: Record<string, string>
	body: string
}

/** Posts one signed delivery and returns the HTTP status the route answered. */
export type WebhookTransport = (delivery: WebhookDelivery) => Promise<number>

export type EmulatorSecrets = {
	stripePlatform: string
	stripeConnect: string
	checkout: string
}

export type EmulatorContext = {
	store: MockStore
	clock: MockClock
	/** Origin of the hosted pages (`PAYMENTS_MOCK_ORIGIN`, else `BASE_URL`). */
	origin: string
	secrets: EmulatorSecrets
	/** Read per event so the mode can follow the environment. */
	webhookMode: () => MockWebhookMode
	/** `null`: events are only recorded (call `flush` yourself). */
	transport: WebhookTransport | null
	/** Runs deferred deliveries; hosts may route this to `ctx.waitUntil`. */
	schedule: (work: Promise<unknown>) => void
	fidelity: {
		/** Put `processing.payment_session_id` (the HPP id) on Checkout.com webhooks. */
		checkoutSessionIdOnWebhooks: boolean
	}
	log: (message: string) => void
}

export const EVENT_CLAIM_STALE_MS = 30_000
