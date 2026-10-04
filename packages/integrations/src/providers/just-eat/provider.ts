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
	const apiKey = readEnv('JUST_EAT_API_KEY')
	const clientId = readEnv('JUST_EAT_CLIENT_ID')
	const clientSecret = readEnv('JUST_EAT_CLIENT_SECRET')
	if (
		!apiKey &&
		!clientId &&
		!clientSecret &&
		useDefaultLocalMockCredentials()
	) {
		return {
			clientId: 'MOCK_JUST_EAT_CLIENT_ID',
			clientSecret: 'MOCK_JUST_EAT_CLIENT_SECRET',
			isMock: true,
		}
	}
	if (apiKey && !clientId) {
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
				clientId: 'MOCK_JUST_EAT_CLIENT_ID',
				clientSecret: 'MOCK_JUST_EAT_CLIENT_SECRET',
				isMock: true,
			}
		}
		throw new Error('Just Eat is not configured')
	}
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both JUST_EAT_CLIENT_ID and JUST_EAT_CLIENT_SECRET when mocking Just Eat.',
		)
	}
	if (
		isMockClientId &&
		readEnv('NODE_ENV') === 'production' &&
		readEnv('MOCKS') !== 'true'
	) {
		throw new Error('Mock Just Eat credentials are disabled in production.')
	}
	return { clientId, clientSecret, isMock: isMockClientId }
}

export function isJustEatMockMode() {
	const apiKey = readEnv('JUST_EAT_API_KEY')
	const clientId = readEnv('JUST_EAT_CLIENT_ID')
	const clientSecret = readEnv('JUST_EAT_CLIENT_SECRET')
	if (!apiKey && !clientId && !clientSecret)
		return useDefaultLocalMockCredentials()
	if (apiKey && !clientId && !clientSecret) return apiKey.startsWith('MOCK_')
	if (!clientId || !clientSecret) return useDefaultLocalMockCredentials()
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both JUST_EAT_CLIENT_ID and JUST_EAT_CLIENT_SECRET when mocking Just Eat.',
		)
	}
	return isMockClientId
}

export class JustEatProvider extends BaseIntegrationProvider {
	readonly name = 'just-eat'
	readonly type = 'business-profile' as const
	readonly displayName = 'Just Eat'
	readonly description =
		'Connect your Just Eat Takeaway restaurant to track diner reviews, ratings, and responses'
	readonly logoPath = '/icons/just-eat.svg'

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
			callback.searchParams.set('code', 'mock-just-eat-code')
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: 'restaurant.reviews',
			state,
		})
		return `https://identity.just-eat.com/connect/authorize?${query}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { isMock } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing Just Eat authorization code or redirect URI')
		if (isMock) {
			if (params.code !== 'mock-just-eat-code') {
				throw new Error('Invalid mock Just Eat authorization code')
			}
			return {
				accessToken: 'mock-just-eat-access-token',
				refreshToken: 'mock-just-eat-refresh-token',
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error('Just Eat live mode OAuth exchange is not supported yet.')
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const { isMock } = credentials()
		if (isMock) {
			if (refreshToken !== 'mock-just-eat-refresh-token') {
				throw new Error('Invalid mock Just Eat refresh token')
			}
			return {
				accessToken: 'mock-just-eat-access-token',
				refreshToken,
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error('Just Eat live mode token refresh is not supported yet.')
	}

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}

	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new Error('Just Eat does not support note messages')
	}

	async validateConnection(
		_integration: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		return true
	}

	getConfigSchema(): Record<string, any> {
		return {}
	}
}
