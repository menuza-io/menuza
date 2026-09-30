import { describe, expect, it } from 'vitest'
import {
	resolveAppCredentials,
	uberEatsOAuthBaseUrl,
} from '../../src/pos/credentials.ts'
import { UBER_EATS_MERCHANT_OAUTH_SCOPE } from '../../src/pos/uber-oauth.ts'
import { UberEatsProvider } from '../../src/pos/providers/ubereats.ts'

const KEYS = [
	'UBER_EATS_CLIENT_ID',
	'UBER_EATS_CLIENT_SECRET',
	'UBER_EATS_AUTHORIZE_URL',
	'UBER_EATS_BASE_URL',
	'UBER_EATS_ENVIRONMENT',
]

function clearUberEnv() {
	for (const key of KEYS) delete process.env[key]
}

describe('Uber Eats OAuth', () => {
	it('defaults Testing apps to sandbox-login.uber.com', async () => {
		clearUberEnv()
		process.env.UBER_EATS_CLIENT_ID = 'uber-client-id'
		process.env.UBER_EATS_CLIENT_SECRET = 'uber-secret'

		const url = await new UberEatsProvider().getAuthUrl(
			'org-1',
			'https://app.menuza.test:2999/api/integrations/oauth/callback',
			{ state: 'signed-state' },
		)

		const parsed = new URL(url)
		expect(parsed.origin).toBe('https://sandbox-login.uber.com')
		expect(parsed.searchParams.get('scope')).toBe(
			UBER_EATS_MERCHANT_OAUTH_SCOPE,
		)
		expect(resolveAppCredentials('ubereats')?.apiBaseUrl).toBe(
			'https://test-api.uber.com',
		)

		clearUberEnv()
	})

	it('uses auth.uber.com when UBER_EATS_ENVIRONMENT=production', async () => {
		clearUberEnv()
		process.env.UBER_EATS_CLIENT_ID = 'uber-client-id'
		process.env.UBER_EATS_CLIENT_SECRET = 'uber-secret'
		process.env.UBER_EATS_ENVIRONMENT = 'production'

		const url = await new UberEatsProvider().getAuthUrl(
			'org-1',
			'https://app.menuza.test:2999/api/integrations/oauth/callback',
			{ state: 'signed-state' },
		)

		expect(new URL(url).origin).toBe('https://auth.uber.com')
		expect(resolveAppCredentials('ubereats')?.apiBaseUrl).toBe(
			'https://api.uber.com',
		)

		clearUberEnv()
	})

	it('maps legacy login.uber.com to the active realm', () => {
		clearUberEnv()
		expect(uberEatsOAuthBaseUrl('https://login.uber.com')).toBe(
			'https://sandbox-login.uber.com',
		)
		process.env.UBER_EATS_ENVIRONMENT = 'production'
		expect(uberEatsOAuthBaseUrl('https://login.uber.com')).toBe(
			'https://auth.uber.com',
		)
		clearUberEnv()
	})
})
