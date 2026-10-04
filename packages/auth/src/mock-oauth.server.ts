import { Cookie } from '@mjackson/headers'
import {
	GITHUB_PROVIDER_NAME,
	GOOGLE_PROVIDER_NAME,
	type ProviderName,
} from './constants.js'
import { ENV } from './package-env.js'
import { type ProviderUser } from './provider.js'

function githubMockEnabled() {
	return (
		process.env.MOCKS === 'true' || ENV.GITHUB_CLIENT_ID?.startsWith('MOCK_')
	)
}

function googleMockEnabled() {
	return (
		process.env.MOCKS === 'true' || ENV.GOOGLE_CLIENT_ID?.startsWith('MOCK_')
	)
}

export function isMockOAuthProvider(providerName: ProviderName) {
	if (providerName === GITHUB_PROVIDER_NAME) return githubMockEnabled()
	if (providerName === GOOGLE_PROVIDER_NAME) return googleMockEnabled()
	return false
}

/** Callback bypass for Workers dev only; Vitest/Playwright use MSW + MOCK_* client ids. */
export function isWorkersDevMockOAuthCallback(providerName: ProviderName) {
	if (process.env.MOCKS !== 'true') return false
	// Playwright sets MOCKS=true for email capture; OAuth still goes through MSW.
	if (process.env.CI === 'true') return false
	return isMockOAuthProvider(providerName)
}

/**
 * Workers dev does not run MSW (see apps/app/workers/dev-mocks.ts). Mock login
 * still skips real OAuth; validate state/code/cookie here and return a stable
 * profile matching `packages/test-utils` GitHub fixtures + db seed.
 */
export function tryAuthenticateMockProvider(
	providerName: ProviderName,
	request: Request,
): ProviderUser | null {
	if (process.env.NODE_ENV === 'production') return null
	if (!isMockOAuthProvider(providerName)) return null

	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	if (!code || !state) return null

	const cookieName = providerName === GITHUB_PROVIDER_NAME ? 'github' : 'google'
	const cookie = new Cookie(request.headers.get('cookie') ?? '')
	const params = new URLSearchParams(cookie.get(cookieName) ?? '')
	if (params.get('state') !== state) return null

	if (providerName === GITHUB_PROVIDER_NAME) {
		// users.0.local.json for MOCK_CODE_GITHUB_KODY (see db seed)
		return {
			id: 1_194_954_954_264_657,
			email: 'Jovan.Runolfsdottir@hotmail.com',
			username: 'Zackary.Carter',
			name: 'Gabriella Kuhlman',
			imageUrl: 'https://github.com/ghost.png',
		}
	}

	if (providerName === GOOGLE_PROVIDER_NAME) {
		return {
			id: 'mock-google-oauth-id',
			email: 'mock.google.user@example.com',
			username: 'mockgoogleuser',
			name: 'Mock Google User',
			imageUrl: undefined,
		}
	}

	return null
}
