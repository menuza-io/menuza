import {
	type Integration,
	type NoteIntegrationConnection,
} from '../../database-types'
import { readEnv } from '../../env-reader.ts'
import { BaseIntegrationProvider } from '../../provider'
import {
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
	type TokenData,
} from '../../types'

/**
 * Google Search Console (#138): adds the restaurant website as a property,
 * verifies it through the meta tag on the home page and submits the sitemap.
 * Uses the same Google OAuth client as Google Business Profile
 * (`GBP_CLIENT_ID` / `GBP_CLIENT_SECRET`, with the Search Console and Site
 * Verification APIs enabled) and the same local mock: without credentials,
 * outside production, the sign-in completes against a mock.
 */
export const SEARCH_CONSOLE_PROVIDER = 'google-search-console'
export const SEARCH_CONSOLE_SCOPES = [
	'https://www.googleapis.com/auth/webmasters',
	'https://www.googleapis.com/auth/siteverification',
]
const MOCK_CODE = 'mock-google-search-console-code'
const MOCK_ACCESS = 'mock-google-search-console-access-token'
const MOCK_REFRESH = 'mock-google-search-console-refresh-token'

function localMockAllowed() {
	return readEnv('MOCKS') === 'true' || readEnv('NODE_ENV') !== 'production'
}

/** The sign-in and the Google APIs run against the local mock. */
export function isSearchConsoleMockMode(): boolean {
	const clientId = readEnv('GBP_CLIENT_ID')
	const clientSecret = readEnv('GBP_CLIENT_SECRET')
	if (!clientId || !clientSecret) return localMockAllowed()
	return clientId.startsWith('MOCK_') && localMockAllowed()
}

function credentials() {
	if (isSearchConsoleMockMode()) {
		return {
			clientId: 'MOCK_GSC_CLIENT_ID',
			clientSecret: 'MOCK',
			isMock: true,
		}
	}
	const clientId = readEnv('GBP_CLIENT_ID')
	const clientSecret = readEnv('GBP_CLIENT_SECRET')
	if (!clientId || !clientSecret || clientId.startsWith('MOCK_')) {
		throw new Error('Google Search Console is not configured')
	}
	return { clientId, clientSecret, isMock: false }
}

async function exchangeToken(params: URLSearchParams): Promise<TokenData> {
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params,
	})
	if (!response.ok)
		throw new Error(`Google token exchange failed (${response.status})`)
	const data = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
		scope?: string
	}
	if (!data.access_token)
		throw new Error('Google did not return an access token')
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in
			? new Date(Date.now() + data.expires_in * 1000)
			: undefined,
		scope: data.scope,
	}
}

export class GoogleSearchConsoleProvider extends BaseIntegrationProvider {
	readonly name = SEARCH_CONSOLE_PROVIDER
	readonly type = 'business-profile' as const
	readonly displayName = 'Google Search Console'
	readonly description =
		'See which searches bring visitors and tell Google about your website'
	readonly logoPath = '/icons/google.svg'

	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	) {
		const { clientId, isMock } = credentials()
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
		if (isMock) {
			const callback = new URL(redirectUri)
			callback.searchParams.set('code', MOCK_CODE)
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SEARCH_CONSOLE_SCOPES.join(' '),
			access_type: 'offline',
			prompt: 'consent',
			state,
		})
		return `https://accounts.google.com/o/oauth2/v2/auth?${query}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { clientId, clientSecret, isMock } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing Google authorization code or redirect URI')
		if (isMock) {
			if (params.code !== MOCK_CODE)
				throw new Error('Invalid mock Search Console authorization code')
			return {
				accessToken: MOCK_ACCESS,
				refreshToken: MOCK_REFRESH,
				expiresAt: new Date(Date.now() + 3600 * 1000),
				scope: SEARCH_CONSOLE_SCOPES.join(' '),
			}
		}
		return exchangeToken(
			new URLSearchParams({
				code: params.code,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: params.redirectUri,
				grant_type: 'authorization_code',
			}),
		)
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const { clientId, clientSecret, isMock } = credentials()
		if (isMock) {
			return {
				accessToken: MOCK_ACCESS,
				refreshToken,
				expiresAt: new Date(Date.now() + 3600 * 1000),
				scope: SEARCH_CONSOLE_SCOPES.join(' '),
			}
		}
		return exchangeToken(
			new URLSearchParams({
				refresh_token: refreshToken,
				client_id: clientId,
				client_secret: clientSecret,
				grant_type: 'refresh_token',
			}),
		)
	}

	/** Disconnecting revokes the grant; the property stays in the owner's account. */
	async revokeToken(
		token: string,
		_integration?: Integration,
		options?: { signal?: AbortSignal },
	) {
		if (isSearchConsoleMockMode()) return
		await fetch(
			`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
			{ method: 'POST', signal: options?.signal },
		)
	}

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}
	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new Error('Google Search Console does not support note messages')
	}
	async validateConnection(): Promise<boolean> {
		return true
	}
	getConfigSchema(): Record<string, any> {
		return {}
	}
}
