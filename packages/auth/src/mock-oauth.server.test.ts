import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderName } from './constants.js'
import {
	type isWorkersDevMockOAuthCallback,
	type tryAuthenticateMockProvider,
} from './mock-oauth.server.ts'

let mockOAuth: {
	isWorkersDevMockOAuthCallback: typeof isWorkersDevMockOAuthCallback
	tryAuthenticateMockProvider: typeof tryAuthenticateMockProvider
}

function createCallbackRequest(
	providerName: ProviderName,
	{
		code = 'mock-code',
		state = 'mock-state',
		cookieState = 'mock-state',
	}: { code?: string; state?: string; cookieState?: string | null } = {},
) {
	const searchParams = new URLSearchParams({ code, state })
	const cookieParams = new URLSearchParams({ code, state: cookieState ?? '' })
	return new Request(
		`http://localhost:3001/auth/${providerName}/callback?${searchParams}`,
		{
			headers: cookieState ? { cookie: `${providerName}=${cookieParams}` } : {},
		},
	)
}

describe('Workers mock OAuth', () => {
	beforeEach(async () => {
		vi.stubEnv('NODE_ENV', 'development')
		vi.stubEnv('MOCKS', 'true')
		vi.stubEnv('CI', '')
		vi.stubEnv('GITHUB_CLIENT_ID', 'MOCK_GITHUB_CLIENT_ID')
		vi.stubEnv('GOOGLE_CLIENT_ID', 'MOCK_GOOGLE_CLIENT_ID')
		vi.stubGlobal('BroadcastChannel', undefined)
		vi.stubGlobal('fetch', vi.fn())
		mockOAuth = await import('./mock-oauth.server.ts')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it.each(['github', 'google'] as const)(
		'authenticates %s without BroadcastChannel or network requests',
		(providerName) => {
			expect(globalThis.BroadcastChannel).toBeUndefined()
			expect(mockOAuth.isWorkersDevMockOAuthCallback(providerName)).toBe(true)
			expect(
				mockOAuth.tryAuthenticateMockProvider(
					providerName,
					createCallbackRequest(providerName),
				),
			).toEqual(
				expect.objectContaining({
					id: expect.anything(),
					email: expect.any(String),
					username: expect.any(String),
				}),
			)
			expect(fetch).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ code: '' },
		{ state: '' },
		{ cookieState: null },
		{ cookieState: 'different-state' },
	])('rejects an invalid callback: %j', (options) => {
		expect(
			mockOAuth.tryAuthenticateMockProvider(
				'github',
				createCallbackRequest('github', options),
			),
		).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
	})

	it('does not bypass the MSW-backed OAuth flow in CI', () => {
		vi.stubEnv('CI', 'true')
		expect(mockOAuth.isWorkersDevMockOAuthCallback('github')).toBe(false)
	})

	it('does not bypass OAuth when Worker mocks are disabled', () => {
		vi.stubEnv('MOCKS', 'false')
		expect(mockOAuth.isWorkersDevMockOAuthCallback('github')).toBe(false)
	})

	it('rejects mock authentication in production', () => {
		vi.stubEnv('NODE_ENV', 'production')
		expect(
			mockOAuth.tryAuthenticateMockProvider(
				'github',
				createCallbackRequest('github'),
			),
		).toBeNull()
	})
})
