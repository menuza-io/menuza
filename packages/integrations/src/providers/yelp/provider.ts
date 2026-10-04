import {
	type Integration,
	type NoteIntegrationConnection,
} from '../../database-types'
import { BaseIntegrationProvider } from '../../provider'
import {
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
	type TokenData,
} from '../../types'

import { readEnv } from '../../env-reader.ts'

function useDefaultLocalMockCredentials() {
	return readEnv('MOCKS') === 'true' || readEnv('NODE_ENV') !== 'production'
}

function credentials() {
	const clientId = readEnv('YELP_CLIENT_ID')
	const clientSecret = readEnv('YELP_CLIENT_SECRET')
	const apiKey = readEnv('YELP_API_KEY')
	if (
		!clientId &&
		!clientSecret &&
		!apiKey &&
		useDefaultLocalMockCredentials()
	) {
		return {
			clientId: 'MOCK_YELP_CLIENT_ID',
			clientSecret: 'MOCK_YELP_CLIENT_SECRET',
			isMock: true,
		}
	}
	if (apiKey && !clientId && !clientSecret) {
		const isMockKey = apiKey.startsWith('MOCK_')
		return {
			clientId: apiKey,
			clientSecret: apiKey,
			isMock: isMockKey,
		}
	}
	if (!clientId || !clientSecret) {
		if (useDefaultLocalMockCredentials()) {
			return {
				clientId: 'MOCK_YELP_CLIENT_ID',
				clientSecret: 'MOCK_YELP_CLIENT_SECRET',
				isMock: true,
			}
		}
		throw new Error('Yelp is not configured')
	}
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both YELP_CLIENT_ID and YELP_CLIENT_SECRET when mocking Yelp.',
		)
	}
	if (
		isMockClientId &&
		readEnv('NODE_ENV') === 'production' &&
		readEnv('MOCKS') !== 'true'
	) {
		throw new Error('Mock Yelp credentials are disabled in production.')
	}
	return { clientId, clientSecret, isMock: isMockClientId }
}

export function isYelpMockMode() {
	const clientId = readEnv('YELP_CLIENT_ID')
	const clientSecret = readEnv('YELP_CLIENT_SECRET')
	const apiKey = readEnv('YELP_API_KEY')
	if (!clientId && !clientSecret && !apiKey)
		return useDefaultLocalMockCredentials()
	if (apiKey && !clientId && !clientSecret) return apiKey.startsWith('MOCK_')
	if (!clientId || !clientSecret) return useDefaultLocalMockCredentials()
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both YELP_CLIENT_ID and YELP_CLIENT_SECRET when mocking Yelp.',
		)
	}
	return isMockClientId
}

async function exchangeToken(params: URLSearchParams): Promise<TokenData> {
	const response = await fetch('https://api.yelp.com/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params,
	})
	if (!response.ok)
		throw new Error(`Yelp token exchange failed (${response.status})`)
	const data = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
		token_type?: string
	}
	if (!data.access_token) throw new Error('Yelp did not return an access token')
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in
			? new Date(Date.now() + data.expires_in * 1000)
			: undefined,
	}
}

export class YelpProvider extends BaseIntegrationProvider {
	readonly name = 'yelp'
	readonly type = 'business-profile' as const
	readonly displayName = 'Yelp'
	readonly description =
		'Connect your Yelp for Business listing to monitor ratings and respond to reviews'
	readonly logoPath = '/icons/yelp.svg'

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
			callback.searchParams.set('code', 'mock-yelp-code')
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: 'business_reviews',
			state,
		})
		return `https://www.yelp.com/oauth2/authorize?${query}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { clientId, clientSecret, isMock } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing Yelp authorization code or redirect URI')
		if (isMock) {
			if (params.code !== 'mock-yelp-code') {
				throw new Error('Invalid mock Yelp authorization code')
			}
			return {
				accessToken: 'mock-yelp-access-token',
				refreshToken: 'mock-yelp-refresh-token',
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
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
			if (refreshToken !== 'mock-yelp-refresh-token') {
				throw new Error('Invalid mock Yelp refresh token')
			}
			return {
				accessToken: 'mock-yelp-access-token',
				refreshToken,
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
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

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}

	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new Error('Yelp does not support note messages')
	}

	async validateConnection(
		integration: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		if (isYelpMockMode()) return true
		return (
			await this.makeAuthenticatedRequest(
				integration.integration,
				'https://api.yelp.com/v3/businesses/search?term=restaurant&limit=1',
			)
		).ok
	}

	getConfigSchema(): Record<string, any> {
		return {}
	}
}
