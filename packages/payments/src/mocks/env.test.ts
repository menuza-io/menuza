import { describe, expect, it } from 'vitest'
import {
	getStripeWebhookSecrets,
	isLocalHostname,
	MOCK_CHECKOUT_SECRET_KEY,
	MOCK_STRIPE_WEBHOOK_SECRET,
	mockWebhookSecrets,
	paymentsMockMode,
} from './env'

const placeholders = {
	STRIPE_SECRET_KEY: 'sk_test_***',
	CHECKOUT_SECRET_KEY: '',
}

describe('paymentsMockMode', () => {
	it('MOCKS=true activates both emulators over placeholder keys', () => {
		expect(paymentsMockMode({ MOCKS: 'true', ...placeholders })).toEqual({
			stripe: true,
			checkout: true,
		})
	})

	it('PAYMENTS_MOCK=true alone activates both emulators', () => {
		expect(
			paymentsMockMode({ PAYMENTS_MOCK: 'true', ...placeholders }),
		).toEqual({
			stripe: true,
			checkout: true,
		})
	})

	it('PAYMENTS_MOCK=false forces off even with MOCKS=true', () => {
		expect(
			paymentsMockMode({
				MOCKS: 'true',
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

	it('refuses a live Stripe key, live webhook secret and live Checkout.com key', () => {
		expect(() =>
			paymentsMockMode({ MOCKS: 'true', STRIPE_SECRET_KEY: 'sk_live_abc123' }),
		).toThrow('live Stripe key')
		expect(() =>
			paymentsMockMode({
				MOCKS: 'true',
				STRIPE_WEBHOOK_SECRET: 'whsec_live_abc',
			}),
		).toThrow('live Stripe webhook secret')
		expect(() =>
			paymentsMockMode({
				MOCKS: 'true',
				CHECKOUT_SECRET_KEY: 'sk_abcdefghijklmnopqrstuvwxyz2',
			}),
		).toThrow('live Checkout.com key')
		expect(() =>
			paymentsMockMode({ MOCKS: 'true', CHECKOUT_SECRET_KEY: 'ack_live_abc' }),
		).toThrow('live Checkout.com key')
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
				STRIPE_SECRET_KEY: 'sk_test_51Realkey',
			}),
		).toEqual({ stripe: false, checkout: true })
		expect(
			paymentsMockMode({
				MOCKS: 'true',
				STRIPE_SECRET_KEY: 'sk_test_***',
				CHECKOUT_SECRET_KEY: 'sk_sbox_abcdefghijklmnopqrstuvwxyz2',
			}),
		).toEqual({ stripe: true, checkout: false })
	})

	it('has no NODE_ENV gate: production with MOCKS=true still activates', () => {
		const env = { MOCKS: 'true', NODE_ENV: 'production', ...placeholders }
		expect(paymentsMockMode(env)).toEqual({ stripe: true, checkout: true })
	})
})

describe('mock secrets', () => {
	it('synthetic Checkout.com key matches the SDK sandbox key pattern', () => {
		expect(MOCK_CHECKOUT_SECRET_KEY).toMatch(
			/^sk_sbox_?[a-z2-7]{26}[a-z2-7*#$=]$/,
		)
	})

	it('signs with the secret the route verifies with, placeholder included', () => {
		const env = { MOCKS: 'true', STRIPE_WEBHOOK_SECRET: 'whsec_***' }
		expect(mockWebhookSecrets(env).stripePlatform).toBe('whsec_***')
		expect(getStripeWebhookSecrets(env)).toEqual(['whsec_***'])
	})

	it('a missing platform secret falls back to the mock secret only while the mock is on', () => {
		expect(mockWebhookSecrets({}).stripePlatform).toBe(
			MOCK_STRIPE_WEBHOOK_SECRET,
		)
		expect(getStripeWebhookSecrets({ MOCKS: 'true' })).toEqual([
			MOCK_STRIPE_WEBHOOK_SECRET,
		])
		expect(getStripeWebhookSecrets({})).toEqual([])
	})

	it('verifies Connect events with the second secret when it is set', () => {
		const env = {
			MOCKS: 'true',
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
