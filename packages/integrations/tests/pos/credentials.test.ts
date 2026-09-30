import { afterEach, describe, expect, it } from 'vitest'
import {
	hasAppCredentials,
	liveApiBaseUrl,
	normalizePosApiBaseUrl,
	normalizePosAuthorizeBaseUrl,
	resolveAppCredentials,
	resolveCredentials,
} from '../../src/pos/credentials'
import { resolveTransport } from '../../src/pos/transport'

describe('POS credentials', () => {
	afterEach(() => {
		delete process.env.SQUARE_APP_ID
		delete process.env.SQUARE_APP_SECRET
		delete process.env.SQUARE_BASE_URL
		delete process.env.SQUARE_AUTHORIZE_URL
		delete process.env.CLOVER_APP_ID
		delete process.env.CLOVER_APP_SECRET
		delete process.env.CLOVER_BASE_URL
	})

	it('defaults to sandbox when nothing is configured', () => {
		const credentials = resolveCredentials('clover')
		expect(credentials.mode).toBe('sandbox')
		expect(credentials.token).toBe('pos-msw-sandbox')
		expect(credentials.merchantId).toBe('M_SANDBOX_CLOVER')
		expect(credentials.baseUrl).toBe('https://apisandbox.dev.clover.com')
	})

	it('does not use platform-wide static tokens for live mode', () => {
		process.env.CLOVER_ACCESS_TOKEN = 'real-clover-token'
		process.env.CLOVER_MERCHANT_ID = 'ABC123'
		expect(resolveCredentials('clover').mode).toBe('sandbox')
		delete process.env.CLOVER_ACCESS_TOKEN
		delete process.env.CLOVER_MERCHANT_ID
	})

	it('detects OAuth app credentials per platform', () => {
		expect(hasAppCredentials('square')).toBe(false)
		process.env.SQUARE_APP_ID = 'sq-app'
		process.env.SQUARE_APP_SECRET = 'sq-secret'
		expect(hasAppCredentials('square')).toBe(true)
		delete process.env.SQUARE_APP_ID
		delete process.env.SQUARE_APP_SECRET
	})

	it('maps Clover authorize host to the REST API host', () => {
		expect(
			normalizePosApiBaseUrl('clover', 'https://sandbox.dev.clover.com'),
		).toBe('https://apisandbox.dev.clover.com')
		process.env.CLOVER_APP_ID = 'app'
		process.env.CLOVER_APP_SECRET = 'secret'
		process.env.CLOVER_BASE_URL = 'https://sandbox.dev.clover.com'
		expect(liveApiBaseUrl('clover')).toBe('https://apisandbox.dev.clover.com')
		delete process.env.CLOVER_APP_ID
		delete process.env.CLOVER_APP_SECRET
		delete process.env.CLOVER_BASE_URL
	})

	it('maps the wrong Square sandbox host to connect.squareupsandbox.com', () => {
		expect(
			normalizePosAuthorizeBaseUrl(
				'square',
				'https://squareupsandbox.com',
				'sandbox-sq0idb-test',
			),
		).toBe('https://connect.squareupsandbox.com')
		expect(
			normalizePosApiBaseUrl(
				'square',
				'https://squareupsandbox.com',
				'sandbox-sq0idb-test',
			),
		).toBe('https://connect.squareupsandbox.com')
		process.env.SQUARE_APP_ID = 'sandbox-sq0idb-test'
		process.env.SQUARE_APP_SECRET = 'secret'
		process.env.SQUARE_AUTHORIZE_URL = 'https://squareupsandbox.com'
		expect(resolveAppCredentials('square')?.authorizeBaseUrl).toBe(
			'https://connect.squareupsandbox.com',
		)
		delete process.env.SQUARE_APP_ID
		delete process.env.SQUARE_APP_SECRET
		delete process.env.SQUARE_AUTHORIZE_URL
	})

	it('maps Uber Testing credentials to sandbox-login + test-api', () => {
		process.env.UBER_EATS_CLIENT_ID = 'uber-id'
		process.env.UBER_EATS_CLIENT_SECRET = 'uber-secret'
		expect(resolveAppCredentials('ubereats')?.authorizeBaseUrl).toBe(
			'https://sandbox-login.uber.com',
		)
		expect(resolveAppCredentials('ubereats')?.apiBaseUrl).toBe(
			'https://test-api.uber.com',
		)
		process.env.UBER_EATS_ENVIRONMENT = 'production'
		expect(resolveAppCredentials('ubereats')?.authorizeBaseUrl).toBe(
			'https://auth.uber.com',
		)
		delete process.env.UBER_EATS_CLIENT_ID
		delete process.env.UBER_EATS_CLIENT_SECRET
		delete process.env.UBER_EATS_ENVIRONMENT
	})

	it('treats MOCK_ app credentials as sandbox placeholders', () => {
		process.env.CLOVER_APP_ID = 'MOCK_clover_app'
		process.env.CLOVER_APP_SECRET = 'MOCK_secret'
		expect(hasAppCredentials('clover')).toBe(false)
		delete process.env.CLOVER_APP_ID
		delete process.env.CLOVER_APP_SECRET
	})
})

describe('POS transport mode', () => {
	it('uses the sandbox mock guard without a stored OAuth token', () => {
		const transport = resolveTransport('clover', 'conn-1', {
			environment: 'sandbox',
			merchantId: 'M_SANDBOX_CLOVER',
		})
		expect(transport.requireMock).toBe(true)
		expect(transport.token).toBe('pos-msw-sandbox')
	})

	it('drops the mock guard when a connection has an OAuth access token', () => {
		const transport = resolveTransport(
			'clover',
			'conn-1',
			{ environment: 'live', merchantId: 'MERCHANT' },
			{ accessToken: 'merchant-token' },
		)
		expect(transport.requireMock).toBe(false)
		expect(transport.token).toBe('merchant-token')
	})
})
