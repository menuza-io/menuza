import { describe, expect, it, vi } from 'vitest'
import {
	getStripeWebhookSecrets,
	isLocalDeployment,
	isLocalHostname,
	MOCK_CHECKOUT_SECRET_KEY,
	MOCK_STRIPE_WEBHOOK_SECRET,
	mockWebhookSecrets,
	paymentsMockMode,
} from './env'

/** A local `BASE_URL`: the mock refuses to run without one. */
const localBase = { BASE_URL: 'http://localhost:3001' }

const placeholders = {
	STRIPE_SECRET_KEY: 'sk_test_***',
	CHECKOUT_SECRET_KEY: '',
}

/** Stubs an env var; leaving the test's scope restores every stub. */
function stubEnv(name: string, value: string) {
	vi.stubEnv(name, value)
	return { [Symbol.dispose]: () => vi.unstubAllEnvs() }
}

describe('paymentsMockMode', () => {
	it('MOCKS=true activates both emulators over placeholder keys', () => {
		expect(
			paymentsMockMode({ MOCKS: 'true', ...localBase, ...placeholders }),
		).toEqual({
			stripe: true,
			checkout: true,
		})
	})

	it('PAYMENTS_MOCK=true alone activates both emulators', () => {
		expect(
			paymentsMockMode({
				PAYMENTS_MOCK: 'true',
				...localBase,
				...placeholders,
			}),
		).toEqual({
			stripe: true,
			checkout: true,
		})
	})

	it('PAYMENTS_MOCK=false forces off even with MOCKS=true', () => {
		expect(
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				PAYMENTS_MOCK: 'false',
				...placeholders,
			}),
		).toEqual({ stripe: false, checkout: false })
	})

	it('is off when neither switch is set', () => {
		expect(paymentsMockMode({ ...placeholders })).toEqual({
			stripe: false,
			checkout: false,
		})
		expect(paymentsMockMode({ MOCKS: 'false', ...placeholders })).toEqual({
			stripe: false,
			checkout: false,
		})
	})

	describe('runtime deployment gate', () => {
		it.each([{ MOCKS: 'true', ...localBase }, { PAYMENTS_MOCK: 'true' }])(
			'refuses %o on a real origin even with no key variables set',
			(switchOn) => {
				expect(() =>
					paymentsMockMode({
						...switchOn,
						BASE_URL: 'https://app.example.com',
					}),
				).toThrow('non-local deployment')
			},
		)

		it.each([
			{ MOCKS: 'true' },
			{ PAYMENTS_MOCK: 'true' },
			{ MOCKS: 'true', BASE_URL: '' },
			{ MOCKS: 'true', BASE_URL: '   ' },
			{ MOCKS: 'true', BASE_URL: 'not a url' },
			// A local override alone cannot stand in for a missing BASE_URL.
			{ MOCKS: 'true', PAYMENTS_MOCK_ORIGIN: 'http://localhost:3001' },
		])('refuses %o when BASE_URL is unset or not a URL', (env) => {
			expect(() => paymentsMockMode({ ...env, ...placeholders })).toThrow(
				'non-local deployment',
			)
			expect(isLocalDeployment(env)).toBe(false)
		})

		it('refuses a real BASE_URL hidden behind a local PAYMENTS_MOCK_ORIGIN', () => {
			expect(() =>
				paymentsMockMode({
					MOCKS: 'true',
					...localBase,
					BASE_URL: 'https://app.example.com',
					PAYMENTS_MOCK_ORIGIN: 'http://localhost:3001',
				}),
			).toThrow('non-local deployment')
		})

		it('refuses a real origin with placeholder keys and with test keys', () => {
			for (const keys of [
				placeholders,
				{ STRIPE_SECRET_KEY: 'sk_test_realtestkey' },
			]) {
				expect(() =>
					paymentsMockMode({
						MOCKS: 'true',
						...localBase,
						BASE_URL: 'https://app.example.com',
						...keys,
					}),
				).toThrow('non-local deployment')
			}
		})

		it.each([
			'http://localhost:3001',
			'http://127.0.0.1:3001',
			'http://[::1]:3001',
			'https://app.menu.test:2999',
			'http://app.localhost:3001',
		])('allows %s even when NODE_ENV=production (start:mocks, CI)', (url) => {
			using ignoredEnv = stubEnv('NODE_ENV', 'production')
			expect(
				paymentsMockMode({
					MOCKS: 'true',
					...localBase,
					BASE_URL: url,
					...placeholders,
				}),
			).toEqual({ stripe: true, checkout: true })
		})

		it('does not check anything while the mock is off', () => {
			const real = { BASE_URL: 'https://app.example.com' }
			expect(paymentsMockMode(real)).toEqual({ stripe: false, checkout: false })
			expect(paymentsMockMode({ ...real, MOCKS: 'false' })).toEqual({
				stripe: false,
				checkout: false,
			})
			expect(
				paymentsMockMode({
					...real,
					MOCKS: 'true',
					...localBase,
					PAYMENTS_MOCK: 'false',
				}),
			).toEqual({ stripe: false, checkout: false })
		})
	})

	it.each(['sk_live_abc123', 'rk_live_abc123', ' sk_live_padded '])(
		'refuses the live Stripe key %s',
		(key) => {
			expect(() =>
				paymentsMockMode({
					MOCKS: 'true',
					...localBase,
					STRIPE_SECRET_KEY: key,
				}),
			).toThrow('live Stripe key')
		},
	)

	it('accepts Stripe test keys and ignores webhook secrets (no live marker exists)', () => {
		for (const key of ['sk_test_51Realkey', 'rk_test_abc']) {
			expect(() =>
				paymentsMockMode({
					MOCKS: 'true',
					...localBase,
					STRIPE_SECRET_KEY: key,
				}),
			).not.toThrow()
		}
		expect(() =>
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				STRIPE_WEBHOOK_SECRET: 'whsec_live_abc',
			}),
		).not.toThrow()
	})

	it.each([
		'sk_abcdefghijklmnopqrstuvwxyz2',
		'ack_live_abc',
		'ack_abc',
		// Checkout.com MBC live keys are a bare UUID.
		'0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
		'Bearer 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
		'something-unrecognised',
	])('treats the Checkout.com key %s as live', (key) => {
		expect(() =>
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				CHECKOUT_SECRET_KEY: key,
			}),
		).toThrow('live Checkout.com key')
	})

	it.each([
		'sk_sbox_abcdefghijklmnopqrstuvwxyz2',
		'ack_test_abc',
		'sk_sbox_***',
	])('accepts the Checkout.com sandbox key %s', (key) => {
		expect(() =>
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				CHECKOUT_SECRET_KEY: key,
			}),
		).not.toThrow()
	})

	it('does not look at a live key while the mock is off', () => {
		expect(paymentsMockMode({ STRIPE_SECRET_KEY: 'sk_live_abc123' })).toEqual({
			stripe: false,
			checkout: false,
		})
	})

	it('a real test key for one provider disables only that provider', () => {
		expect(
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				STRIPE_SECRET_KEY: 'sk_test_51Realkey',
			}),
		).toEqual({ stripe: false, checkout: true })
		expect(
			paymentsMockMode({
				MOCKS: 'true',
				...localBase,
				STRIPE_SECRET_KEY: 'sk_test_***',
				CHECKOUT_SECRET_KEY: 'sk_sbox_abcdefghijklmnopqrstuvwxyz2',
			}),
		).toEqual({ stripe: true, checkout: false })
	})

	it('has no NODE_ENV gate: production with MOCKS=true still activates', () => {
		const env = {
			MOCKS: 'true',
			...localBase,
			NODE_ENV: 'production',
			...placeholders,
		}
		expect(paymentsMockMode(env)).toEqual({ stripe: true, checkout: true })
	})
})

const LOCAL = { url: 'http://localhost:3001/api/stripe/webhook' }
const REMOTE = { url: 'https://app.example.com/api/stripe/webhook' }

describe('mock secrets', () => {
	it('synthetic Checkout.com key matches the SDK sandbox key pattern', () => {
		expect(MOCK_CHECKOUT_SECRET_KEY).toMatch(
			/^sk_sbox_?[a-z2-7]{26}[a-z2-7*#$=]$/,
		)
	})

	it('signs with the secret the route verifies with, placeholder included', () => {
		const env = {
			MOCKS: 'true',
			...localBase,
			STRIPE_WEBHOOK_SECRET: 'whsec_***',
		}
		expect(mockWebhookSecrets(env).stripePlatform).toBe('whsec_***')
		expect(getStripeWebhookSecrets(env, LOCAL)).toEqual(['whsec_***'])
	})

	it('a missing platform secret falls back to the mock secret only while the mock is on', () => {
		expect(mockWebhookSecrets({}).stripePlatform).toBe(
			MOCK_STRIPE_WEBHOOK_SECRET,
		)
		expect(
			getStripeWebhookSecrets({ MOCKS: 'true', ...localBase }, LOCAL),
		).toEqual([MOCK_STRIPE_WEBHOOK_SECRET])
		expect(getStripeWebhookSecrets({}, LOCAL)).toEqual([])
	})

	it('never offers the public mock secret to a non-local request or deployment', () => {
		// A node started with MOCKS=true and no real secret must not accept
		// forged events from the internet.
		expect(getStripeWebhookSecrets({ MOCKS: 'true', ...localBase })).toEqual([])
		expect(
			getStripeWebhookSecrets({ MOCKS: 'true', ...localBase }, REMOTE),
		).toEqual([])
		expect(
			getStripeWebhookSecrets(
				{ MOCKS: 'true', ...localBase, BASE_URL: 'https://app.example.com' },
				LOCAL,
			),
		).toEqual([])
		expect(
			getStripeWebhookSecrets(
				{
					MOCKS: 'true',
					...localBase,
					PAYMENTS_MOCK_ORIGIN: 'https://app.example.com',
				},
				LOCAL,
			),
		).toEqual([])
		expect(
			getStripeWebhookSecrets(
				{ MOCKS: 'true', ...localBase, BASE_URL: 'https://a.test' },
				LOCAL,
			),
		).toEqual([MOCK_STRIPE_WEBHOOK_SECRET])
	})

	it('verifies Connect events with the second secret when it is set', () => {
		const env = {
			MOCKS: 'true',
			...localBase,
			STRIPE_WEBHOOK_SECRET: 'whsec_platform',
			STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
		}
		expect(getStripeWebhookSecrets(env)).toEqual([
			'whsec_platform',
			'whsec_connect',
		])
		expect(mockWebhookSecrets(env).stripeConnect).toBe('whsec_connect')
	})

	it('verifies with the configured secrets only when the mock is off', () => {
		expect(
			getStripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: 'whsec_real' }),
		).toEqual(['whsec_real'])
		expect(
			getStripeWebhookSecrets({
				STRIPE_WEBHOOK_SECRET: 'whsec_real',
				STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect',
			}),
		).toEqual(['whsec_real', 'whsec_connect'])
	})
})

describe('isLocalHostname', () => {
	it.each([
		'localhost',
		'127.0.0.1',
		'[::1]',
		'acme.localhost',
		'app.example.test',
	])('%s is local', (host) => expect(isLocalHostname(host)).toBe(true))
	it.each(['app.example.io', 'example.com', 'localhost.evil.com', 'test.com'])(
		'%s is not local',
		(host) => expect(isLocalHostname(host)).toBe(false),
	)
})
