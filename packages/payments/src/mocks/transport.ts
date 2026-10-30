import Stripe from 'stripe'
import { type PaymentsEmulator } from './emulator'
import { MOCK_CHECKOUT_HOST } from './env'

/** A Stripe HTTP client whose "network" is the in-process emulator. */
export function createMockStripeHttpClient(emulator: PaymentsEmulator) {
	return Stripe.createFetchHttpClient(
		(url: string | URL | Request, init?: RequestInit) =>
			emulator.stripe.fetch(new Request(url as string, init)),
	)
}

type FetchLike = typeof fetch
const CURRENT = Symbol.for('payments-mock.checkout-emulator')
const PATCHED = Symbol.for('payments-mock.checkout-fetch')

/**
 * The Checkout.com SDK always calls global `fetch`, so only the dedicated
 * `.invalid` host is intercepted. Safe to call repeatedly: the wrapper is
 * installed once and each call just points it at the newest emulator.
 */
export function installCheckoutComMockFetch(emulator: PaymentsEmulator) {
	const scope = globalThis as unknown as Record<symbol, unknown>
	scope[CURRENT] = emulator
	if (scope[PATCHED]) return
	const original: FetchLike = globalThis.fetch.bind(globalThis)
	const wrapped: FetchLike = async (input, init) => {
		const request =
			input instanceof Request ? input : new Request(input as string, init)
		if (new URL(request.url).origin === MOCK_CHECKOUT_HOST) {
			const current = scope[CURRENT] as PaymentsEmulator | undefined
			if (!current)
				throw new Error('Checkout.com mock host called without an emulator')
			return current.checkout.fetch(request)
		}
		return original(input, init)
	}
	globalThis.fetch = wrapped
	scope[PATCHED] = true
}
