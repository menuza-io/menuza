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

const SCOPE = 'https://www.googleapis.com/auth/business.manage'

function useDefaultLocalMockCredentials() {
	return readEnv('MOCKS') === 'true' || readEnv('NODE_ENV') !== 'production'
}

function credentials() {
	const clientId = readEnv('GBP_CLIENT_ID')
	const clientSecret = readEnv('GBP_CLIENT_SECRET')
	if (!clientId && !clientSecret && useDefaultLocalMockCredentials()) {
		return {
			clientId: 'MOCK_GBP_CLIENT_ID',
			clientSecret: 'MOCK_GBP_CLIENT_SECRET',
			isMock: true,
		}
	}
	if (!clientId || !clientSecret) {
		if (useDefaultLocalMockCredentials()) {
			return {
				clientId: 'MOCK_GBP_CLIENT_ID',
				clientSecret: 'MOCK_GBP_CLIENT_SECRET',
				isMock: true,
			}
		}
		throw new Error('Google Business Profile is not configured')
	}
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both GBP_CLIENT_ID and GBP_CLIENT_SECRET when mocking Google Business Profile.',
		)
	}
	if (
		isMockClientId &&
		readEnv('NODE_ENV') === 'production' &&
		readEnv('MOCKS') !== 'true'
	) {
		throw new Error(
			'Mock Google Business Profile credentials are disabled in production.',
		)
	}
	return { clientId, clientSecret, isMock: isMockClientId }
}

export function isGoogleBusinessProfileMockMode() {
	const clientId = readEnv('GBP_CLIENT_ID')
	const clientSecret = readEnv('GBP_CLIENT_SECRET')
	if (!clientId && !clientSecret) return useDefaultLocalMockCredentials()
	if (!clientId || !clientSecret) return useDefaultLocalMockCredentials()
	const isMockClientId = clientId.startsWith('MOCK_')
	const isMockClientSecret = clientSecret.startsWith('MOCK_')
	if (isMockClientId !== isMockClientSecret) {
		throw new Error(
			'Use MOCK_ for both GBP_CLIENT_ID and GBP_CLIENT_SECRET when mocking Google Business Profile.',
		)
	}
	return isMockClientId
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

export class GoogleBusinessProfileProvider extends BaseIntegrationProvider {
	readonly name = 'google-business-profile'
	readonly type = 'business-profile' as const
	readonly displayName = 'Google Business Profile'
	readonly description = 'Import restaurant details from your Google listing'
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
			callback.searchParams.set('code', 'mock-google-business-profile-code')
			callback.searchParams.set('state', state)
			return callback.toString()
		}
		const query = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
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
			if (params.code !== 'mock-google-business-profile-code') {
				throw new Error(
					'Invalid mock Google Business Profile authorization code',
				)
			}
			return {
				accessToken: 'mock-google-business-profile-access-token',
				refreshToken: 'mock-google-business-profile-refresh-token',
				expiresAt: new Date(Date.now() + 3600 * 1000),
				scope: SCOPE,
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
			if (refreshToken !== 'mock-google-business-profile-refresh-token') {
				throw new Error('Invalid mock Google Business Profile refresh token')
			}
			return {
				accessToken: 'mock-google-business-profile-access-token',
				refreshToken,
				expiresAt: new Date(Date.now() + 3600 * 1000),
				scope: SCOPE,
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
		throw new Error('Google Business Profile does not support note messages')
	}
	async validateConnection(
		integration: NoteIntegrationConnection & { integration: Integration },
	): Promise<boolean> {
		if (isGoogleBusinessProfileMockMode()) return true
		return (
			await this.makeAuthenticatedRequest(
				integration.integration,
				'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=1',
			)
		).ok
	}
	getConfigSchema(): Record<string, any> {
		return {}
	}
}
