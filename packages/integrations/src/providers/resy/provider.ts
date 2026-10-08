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
	const apiKey = readEnv('RESY_API_KEY')
	const clientId = readEnv('RESY_CLIENT_ID')
	const clientSecret = readEnv('RESY_CLIENT_SECRET')
	if (
		!apiKey &&
		!clientId &&
		!clientSecret &&
		useDefaultLocalMockCredentials()
	) {
		return {
			clientId: 'MOCK_RESY_CLIENT_ID',
			clientSecret: 'MOCK_RESY_CLIENT_SECRET',
			isMock: true,
		}
	}
	if (apiKey && !clientId) {
		const isMockKey = apiKey.startsWith('MOCK_')
		if (
			isMockKey &&
			readEnv('NODE_ENV') === 'production' &&
			readEnv('MOCKS') !== 'true'
		) {
			throw new Error('Resy mock credentials cannot be used in production')
		}
		return {
			clientId: apiKey,
			clientSecret: apiKey,
			isMock: isMockKey,
		}
	}
	if (!clientId || !clientSecret) {
		if (useDefaultLocalMockCredentials()) {
			return {
				clientId: 'MOCK_RESY_CLIENT_ID',
				clientSecret: 'MOCK_RESY_CLIENT_SECRET',
				isMock: true,
			}
		}
		throw new Error('Resy is not configured')
	}
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both RESY_CLIENT_ID and RESY_CLIENT_SECRET when mocking Resy.',
		)
	}
	if (
		isMockClientId &&
		readEnv('NODE_ENV') === 'production' &&
		readEnv('MOCKS') !== 'true'
	) {
		throw new Error('Mock Resy credentials are disabled in production.')
	}
	return { clientId, clientSecret, isMock: isMockClientId }
}

export function isResyMockMode() {
	const apiKey = readEnv('RESY_API_KEY')
	const clientId = readEnv('RESY_CLIENT_ID')
	const clientSecret = readEnv('RESY_CLIENT_SECRET')
	if (!apiKey && !clientId && !clientSecret)
		return useDefaultLocalMockCredentials()
	if (apiKey && !clientId && !clientSecret) return apiKey.startsWith('MOCK_')
	if (!clientId || !clientSecret) return useDefaultLocalMockCredentials()
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both RESY_CLIENT_ID and RESY_CLIENT_SECRET when mocking Resy.',
		)
	}
	return isMockClientId
}

export class ResyProvider extends BaseIntegrationProvider {
	readonly name = 'resy'
	readonly type = 'business-profile' as const
	readonly displayName = 'Resy'
	readonly description =
		'Connect your Resy venue to manage guest reviews and reservation feedback'
	readonly logoPath = '/icons/resy.svg'

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
			callback.searchParams.set('code', 'mock-resy-code')
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: 'venue.reviews',
			state,
		})
		return `https://os.resy.com/oauth/authorize?${query}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { isMock } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing Resy authorization code or redirect URI')
		if (isMock) {
			if (params.code !== 'mock-resy-code') {
				throw new Error('Invalid mock Resy authorization code')
			}
			return {
				accessToken: 'mock-resy-access-token',
				refreshToken: 'mock-resy-refresh-token',
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error('Resy live mode OAuth exchange is not supported yet.')
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const { isMock } = credentials()
		if (isMock) {
			if (refreshToken !== 'mock-resy-refresh-token') {
				throw new Error('Invalid mock Resy refresh token')
			}
			return {
				accessToken: 'mock-resy-access-token',
				refreshToken,
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error('Resy live mode token refresh is not supported yet.')
	}

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}

	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new Error('Resy does not support note messages')
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
