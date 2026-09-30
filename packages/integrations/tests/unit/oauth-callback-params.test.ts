import { describe, expect, it } from 'vitest'
import {
	integrationOAuthCallbackUrl,
	needsCloverAuthorizeStep,
	readOAuthAuthorizationCode,
} from '../../src/oauth-callback-params.ts'

describe('oauth callback params', () => {
	it('reads Clover legacy authorization code query names', () => {
		const url = new URL(
			'https://app.test/api/integrations/oauth/callback?authorization_code=ABC',
		)
		expect(readOAuthAuthorizationCode(url)).toBe('ABC')
	})

	it('detects Clover launch step without a code', () => {
		const url = new URL('https://app.test/cb?merchant_id=M1&client_id=APP')
		expect(needsCloverAuthorizeStep(url, null)).toBe(true)
		expect(needsCloverAuthorizeStep(url, 'code')).toBe(false)
	})

	it('builds callback URL from BASE_URL', () => {
		expect(integrationOAuthCallbackUrl('https://app.menuza.test:2999')).toBe(
			'https://app.menuza.test:2999/api/integrations/oauth/callback',
		)
	})
})
