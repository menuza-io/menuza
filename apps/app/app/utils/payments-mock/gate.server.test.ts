import { describe, expect, it } from 'vitest'
import { getPaymentsMockStatus, requirePaymentsMock } from './gate.server.ts'

const local = new Request('http://localhost:3001/mock-payments/dashboard')
const placeholders = {
	STRIPE_SECRET_KEY: 'sk_test_***',
	CHECKOUT_SECRET_KEY: '',
}

async function status(run: () => unknown) {
	try {
		run()
		return 200
	} catch (thrown) {
		if (thrown instanceof Response) return thrown.status
		throw thrown
	}
}

describe('payments mock gate (VAL-PMOCK-002, VAL-PMOCK-003)', () => {
	it('is on for MOCKS=true or PAYMENTS_MOCK=true on a local request', () => {
		expect(
			getPaymentsMockStatus(local, { MOCKS: 'true', ...placeholders }),
		).toEqual({ enabled: true, stripe: true, checkout: true })
		expect(
			getPaymentsMockStatus(local, { PAYMENTS_MOCK: 'true', ...placeholders })
				.enabled,
		).toBe(true)
	})

	it('answers 404 with no switch, with PAYMENTS_MOCK=false, and for a live key', async () => {
		expect(
			await status(() =>
				requirePaymentsMock(local, undefined, { ...placeholders }),
			),
		).toBe(404)
		expect(
			await status(() =>
				requirePaymentsMock(local, undefined, {
					MOCKS: 'true',
					PAYMENTS_MOCK: 'false',
				}),
			),
		).toBe(404)
		expect(
			await status(() =>
				requirePaymentsMock(local, undefined, {
					MOCKS: 'true',
					STRIPE_SECRET_KEY: 'sk_live_x',
				}),
			),
		).toBe(404)
	})

	it('also needs a local request and a local origin (not-production check)', async () => {
		const env = { MOCKS: 'true', ...placeholders }
		const remote = new Request('https://app.menuza.io/mock-payments/dashboard')
		expect(
			await status(() => requirePaymentsMock(remote, undefined, env)),
		).toBe(404)
		expect(
			await status(() =>
				requirePaymentsMock(local, undefined, {
					...env,
					BASE_URL: 'https://app.menuza.io',
				}),
			),
		).toBe(404)
		expect(
			await status(() =>
				requirePaymentsMock(
					new Request('https://app.menuza.test:2999/x'),
					undefined,
					{ ...env, BASE_URL: 'https://app.menuza.test:2999' },
				),
			),
		).toBe(200)
	})

	it('a provider with a real key has no mock pages', async () => {
		const env = {
			MOCKS: 'true',
			STRIPE_SECRET_KEY: 'sk_test_51Real',
			CHECKOUT_SECRET_KEY: '',
		}
		expect(await status(() => requirePaymentsMock(local, 'stripe', env))).toBe(
			404,
		)
		expect(
			await status(() => requirePaymentsMock(local, 'checkout', env)),
		).toBe(200)
	})
})
