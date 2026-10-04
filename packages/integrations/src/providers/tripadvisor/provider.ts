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
	const apiKey = readEnv('TRIPADVISOR_API_KEY')
	const clientId = readEnv('TRIPADVISOR_CLIENT_ID')
	const clientSecret = readEnv('TRIPADVISOR_CLIENT_SECRET')
	if (
		!apiKey &&
		!clientId &&
		!clientSecret &&
		useDefaultLocalMockCredentials()
	) {
		return {
			clientId: 'MOCK_TRIPADVISOR_CLIENT_ID',
			clientSecret: 'MOCK_TRIPADVISOR_CLIENT_SECRET',
			isMock: true,
		}
	}
	if (apiKey && !clientId) {
		const isMockKey = apiKey.startsWith('MOCK_')
		if (
			isMockKey &&
			process.env.NODE_ENV === 'production' &&
			process.env.MOCKS !== 'true'
		) {
			throw new Error(
				'TripAdvisor mock credentials cannot be used in production',
			)
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
				clientId: 'MOCK_TRIPADVISOR_CLIENT_ID',
				clientSecret: 'MOCK_TRIPADVISOR_CLIENT_SECRET',
				isMock: true,
			}
		}
		throw new Error('TripAdvisor is not configured')
	}
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both TRIPADVISOR_CLIENT_ID and TRIPADVISOR_CLIENT_SECRET when mocking TripAdvisor.',
		)
	}
	if (
		isMockClientId &&
		readEnv('NODE_ENV') === 'production' &&
		readEnv('MOCKS') !== 'true'
	) {
		throw new Error('Mock TripAdvisor credentials are disabled in production.')
	}
	return { clientId, clientSecret, isMock: isMockClientId }
}

export function isTripAdvisorMockMode() {
	const apiKey = readEnv('TRIPADVISOR_API_KEY')
	const clientId = readEnv('TRIPADVISOR_CLIENT_ID')
	const clientSecret = readEnv('TRIPADVISOR_CLIENT_SECRET')
	if (!apiKey && !clientId && !clientSecret)
		return useDefaultLocalMockCredentials()
	if (apiKey && !clientId && !clientSecret) return apiKey.startsWith('MOCK_')
	if (!clientId || !clientSecret) return useDefaultLocalMockCredentials()
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both TRIPADVISOR_CLIENT_ID and TRIPADVISOR_CLIENT_SECRET when mocking TripAdvisor.',
		)
	}
	return isMockClientId
}

export class TripAdvisorProvider extends BaseIntegrationProvider {
	readonly name = 'tripadvisor'
	readonly type = 'business-profile' as const
	readonly displayName = 'TripAdvisor'
	readonly description =
		'Connect your TripAdvisor listing to track traveler reviews and ratings'
	readonly logoPath = '/icons/tripadvisor.svg'

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
			callback.searchParams.set('code', 'mock-tripadvisor-code')
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			state,
		})
		return `https://www.tripadvisor.com/OAuth?${query}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const { isMock } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing TripAdvisor authorization code or redirect URI')
		if (isMock) {
			if (params.code !== 'mock-tripadvisor-code') {
				throw new Error('Invalid mock TripAdvisor authorization code')
			}
			return {
				accessToken: 'mock-tripadvisor-access-token',
				refreshToken: 'mock-tripadvisor-refresh-token',
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error(
			'TripAdvisor live mode OAuth exchange is not supported yet.',
		)
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const { isMock } = credentials()
		if (isMock) {
			if (refreshToken !== 'mock-tripadvisor-refresh-token') {
				throw new Error('Invalid mock TripAdvisor refresh token')
			}
			return {
				accessToken: 'mock-tripadvisor-access-token',
				refreshToken,
				expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			}
		}
		throw new Error('TripAdvisor live mode token refresh is not supported yet.')
	}

	async getAvailableChannels(_integration: Integration): Promise<Channel[]> {
		return []
	}

	async postMessage(
		_connection: NoteIntegrationConnection & { integration: Integration },
		_message: MessageData,
	): Promise<void> {
		throw new Error('TripAdvisor does not support note messages')
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
