import {
	type WebhookDelivery,
	type WebhookTransport,
} from '@repo/payments/mock'
import { RouterContextProvider } from 'react-router'

/**
 * Deliver a signed mock webhook to the real route.
 *
 * By default the route's `action` runs in this process: Workers dev cannot
 * fetch its own origin reliably, and the route still does everything it does
 * in production (signature check, dispatch, status code). With
 * `PAYMENTS_MOCK_WEBHOOKS_HTTP=1` the request goes over HTTP to the mock origin.
 */
export function createWebhookTransport(): WebhookTransport {
	return async (delivery: WebhookDelivery) => {
		const origin = (
			process.env.PAYMENTS_MOCK_ORIGIN ||
			process.env.BASE_URL ||
			'http://localhost:3001'
		).replace(/\/$/, '')
		const request = new Request(`${origin}${delivery.path}`, {
			method: 'POST',
			headers: delivery.headers,
			body: delivery.body,
		})
		if (process.env.PAYMENTS_MOCK_WEBHOOKS_HTTP === '1') {
			return (await fetch(request)).status
		}
		const route =
			delivery.provider === 'checkout'
				? await import('#app/routes/api+/shop+/webhook.tsx')
				: await import('#app/routes/api+/stripe+/webhook.tsx')
		try {
			const response = await route.action({
				request,
				params: {},
				context: new RouterContextProvider(),
				unstable_pattern: delivery.path,
			} as never)
			return response instanceof Response ? response.status : 200
		} catch (thrown) {
			// A route may throw a Response (an HTTP status), never anything else.
			if (thrown instanceof Response) return thrown.status
			throw thrown
		}
	}
}
