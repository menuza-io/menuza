import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	GoogleSearchConsoleProvider,
	isSearchConsoleMockMode,
	SEARCH_CONSOLE_SCOPES,
} from '../../src/providers/google-search-console/provider'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe('Google Search Console provider (#138)', () => {
	it('asks Google for the Search Console and Site Verification scopes, offline', async () => {
		vi.stubEnv('GBP_CLIENT_ID', 'client-id')
		vi.stubEnv('GBP_CLIENT_SECRET', 'client-secret')
		vi.stubEnv('NODE_ENV', 'production')
		expect(isSearchConsoleMockMode()).toBe(false)
		const url = new URL(
			await new GoogleSearchConsoleProvider().getAuthUrl(
				'org_1',
				'https://app.example/api/integrations/oauth/callback',
				{ state: 'state-1' },
			),
		)
		expect(url.origin).toBe('https://accounts.google.com')
		expect(url.searchParams.get('scope')).toBe(SEARCH_CONSOLE_SCOPES.join(' '))
		expect(url.searchParams.get('access_type')).toBe('offline')
		expect(url.searchParams.get('state')).toBe('state-1')
		expect(url.searchParams.get('client_id')).toBe('client-id')
	})

	it('exchanges the code for tokens', async () => {
		vi.stubEnv('GBP_CLIENT_ID', 'client-id')
		vi.stubEnv('GBP_CLIENT_SECRET', 'client-secret')
		vi.stubEnv('NODE_ENV', 'production')
		const fetchMock = vi.fn(async () =>
			Response.json({
				access_token: 'a',
				refresh_token: 'r',
				expires_in: 3600,
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
		const tokens = await new GoogleSearchConsoleProvider().handleCallback({
			code: 'code-1',
			state: 'state-1',
			redirectUri: 'https://app.example/cb',
		} as never)
		expect(tokens).toMatchObject({ accessToken: 'a', refreshToken: 'r' })
		expect(fetchMock).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/token',
			expect.objectContaining({ method: 'POST' }),
		)
	})

	it('completes against the mock without credentials outside production', async () => {
		vi.stubEnv('GBP_CLIENT_ID', '')
		vi.stubEnv('GBP_CLIENT_SECRET', '')
		vi.stubEnv('NODE_ENV', 'development')
		expect(isSearchConsoleMockMode()).toBe(true)
		const provider = new GoogleSearchConsoleProvider()
		const url = new URL(
			await provider.getAuthUrl('org_1', 'https://app.test/cb', { state: 's' }),
		)
		expect(url.origin).toBe('https://app.test')
		const tokens = await provider.handleCallback({
			code: url.searchParams.get('code')!,
			state: 's',
			redirectUri: 'https://app.test/cb',
		} as never)
		expect(tokens.accessToken).toBe('mock-google-search-console-access-token')
	})

	it('refuses to run in production without credentials', async () => {
		vi.stubEnv('GBP_CLIENT_ID', '')
		vi.stubEnv('GBP_CLIENT_SECRET', '')
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('MOCKS', '')
		await expect(
			new GoogleSearchConsoleProvider().getAuthUrl(
				'org_1',
				'https://app.example/cb',
			),
		).rejects.toThrow('not configured')
	})
})
