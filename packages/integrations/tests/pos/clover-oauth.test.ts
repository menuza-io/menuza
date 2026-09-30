import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

const consumedOAuthNonces = new Set<string>()
vi.mock('../../src/oauth-nonce-store.ts', () => ({
	registerOAuthNonce: vi.fn(async (nonce: string) => {
		consumedOAuthNonces.delete(nonce)
	}),
	consumeOAuthNonce: vi.fn(async (nonce: string) => {
		if (consumedOAuthNonces.has(nonce)) return false
		consumedOAuthNonces.add(nonce)
		return true
	}),
	isOAuthNonceConsumed: vi.fn(async (nonce: string) =>
		consumedOAuthNonces.has(nonce),
	),
}))

import { OAuthStateManager } from '../../src/oauth-manager'

afterEach(() => {
	OAuthStateManager.clearConsumedNonces()
})
import {
	hasAppCredentials,
	resolveAppCredentials,
	shouldSkipMock,
} from '../../src/pos/credentials'
import { CloverProvider } from '../../src/pos/providers/clover'
import { server } from '../setup'

const KEYS = [
	'CLOVER_APP_ID',
	'CLOVER_APP_SECRET',
	'CLOVER_ACCESS_TOKEN',
	'CLOVER_MERCHANT_ID',
	'CLOVER_BASE_URL',
	'CLOVER_AUTHORIZE_URL',
]

afterEach(() => {
	for (const key of KEYS) delete process.env[key]
})

function setAppCredentials() {
	process.env.CLOVER_APP_ID = 'APP_ID'
	process.env.CLOVER_APP_SECRET = 'APP_SECRET'
}

describe('Clover OAuth', () => {
	it('builds the authorize URL with the client id and state', async () => {
		setAppCredentials()
		const provider = new CloverProvider()
		const authUrl = await provider.getAuthUrl(
			'org-1',
			'https://app.test/api/integrations/oauth/callback',
		)
		const url = new URL(authUrl)
		expect(`${url.origin}${url.pathname}`).toBe(
			'https://sandbox.dev.clover.com/oauth/v2/authorize',
		)
		expect(url.searchParams.get('client_id')).toBe('APP_ID')
		expect(url.searchParams.get('response_type')).toBe('code')
		expect(url.searchParams.get('redirect_uri')).toContain(
			'/api/integrations/oauth/callback',
		)
		expect(url.searchParams.get('state')).toBeTruthy()
	})

	it('includes merchant_id when continuing a Clover launch callback', async () => {
		setAppCredentials()
		const provider = new CloverProvider()
		const authUrl = await provider.getAuthUrl(
			'org-1',
			'https://app.test/api/integrations/oauth/callback',
			{ merchantId: 'MERCHANT123', state: 'signed-state' },
		)
		const url = new URL(authUrl)
		expect(url.searchParams.get('merchant_id')).toBe('MERCHANT123')
	})

	it('handleCallback works after oauth-flow already consumed the state nonce', async () => {
		setAppCredentials()
		server.use(
			http.post('https://apisandbox.dev.clover.com/oauth/v2/token', () =>
				HttpResponse.json({ access_token: 'ACCESS' }),
			),
		)
		const state = OAuthStateManager.generateState(
			'org-1',
			'clover',
			undefined,
			{
				oauthRedirectUri: 'https://app.test/api/integrations/oauth/callback',
			},
		)
		await OAuthStateManager.registerStateNonce(state)
		await OAuthStateManager.validateState(state, true)
		const token = await new CloverProvider().handleCallback({
			organizationId: 'org-1',
			code: 'CODE',
			state,
			redirectUri: 'https://app.test/api/integrations/oauth/callback',
			merchantId: 'FROM_CALLBACK',
		})
		expect(token.accessToken).toBe('ACCESS')
	})

	it('exchanges the code and discovers the merchant id', async () => {
		setAppCredentials()
		server.use(
			http.post(
				'https://apisandbox.dev.clover.com/oauth/v2/token',
				async ({ request }) => {
					const body = (await request.json()) as Record<string, string>
					expect(body.client_id).toBe('APP_ID')
					expect(body.client_secret).toBe('APP_SECRET')
					expect(body.code).toBe('CODE')
					return HttpResponse.json({
						access_token: 'ACCESS',
						refresh_token: 'REFRESH',
						access_token_expiration: 4102444800,
						refresh_token_expiration: 4102444800,
					})
				},
			),
			http.get(
				'https://apisandbox.dev.clover.com/v3/merchants',
				({ request }) => {
					expect(request.headers.get('authorization')).toBe('Bearer ACCESS')
					return HttpResponse.json({ elements: [{ id: 'MERCHANT123' }] })
				},
			),
		)

		const state = OAuthStateManager.generateState('org-1', 'clover')
		const token = await new CloverProvider().handleCallback({
			organizationId: 'org-1',
			code: 'CODE',
			state,
		})

		expect(token.accessToken).toBe('ACCESS')
		expect(token.refreshToken).toBe('REFRESH')
		expect(token.metadata?.merchantId).toBe('MERCHANT123')
		expect(token.expiresAt?.getTime()).toBe(4102444800 * 1000)
	})

	it('uses the merchant id from the callback without an API lookup', async () => {
		setAppCredentials()
		let merchantsCalled = false
		server.use(
			http.post('https://apisandbox.dev.clover.com/oauth/v2/token', () =>
				HttpResponse.json({ access_token: 'ACCESS' }),
			),
			http.get('https://apisandbox.dev.clover.com/v3/merchants', () => {
				merchantsCalled = true
				return HttpResponse.json({ elements: [] })
			}),
		)

		const state = OAuthStateManager.generateState('org-1', 'clover')
		const token = await new CloverProvider().handleCallback({
			organizationId: 'org-1',
			code: 'CODE',
			state,
			merchantId: 'FROM_CALLBACK',
		})

		expect(token.metadata?.merchantId).toBe('FROM_CALLBACK')
		expect(merchantsCalled).toBe(false)
	})

	it('refreshes an access token', async () => {
		setAppCredentials()
		server.use(
			http.post(
				'https://apisandbox.dev.clover.com/oauth/v2/refresh',
				async ({ request }) => {
					const body = (await request.json()) as Record<string, string>
					expect(body.refresh_token).toBe('OLD_REFRESH')
					return HttpResponse.json({
						access_token: 'NEW_ACCESS',
						refresh_token: 'NEW_REFRESH',
						access_token_expiration: 4102444800,
					})
				},
			),
		)

		const token = await new CloverProvider().refreshToken('OLD_REFRESH')
		expect(token.accessToken).toBe('NEW_ACCESS')
		expect(token.refreshToken).toBe('NEW_REFRESH')
	})

	it('throws a helpful error without app credentials', async () => {
		await expect(
			new CloverProvider().getAuthUrl('org-1', 'https://app.test/cb'),
		).rejects.toThrow(/CLOVER_APP_ID/)
	})

	it('detects app credentials and skips the mock', () => {
		expect(hasAppCredentials('clover')).toBe(false)
		expect(shouldSkipMock('clover')).toBe(false)

		setAppCredentials()
		expect(hasAppCredentials('clover')).toBe(true)
		expect(shouldSkipMock('clover')).toBe(true)
		expect(resolveAppCredentials('clover')?.apiBaseUrl).toBe(
			'https://apisandbox.dev.clover.com',
		)
		expect(resolveAppCredentials('clover')?.authorizeBaseUrl).toBe(
			'https://sandbox.dev.clover.com',
		)
	})
})
