import {
	type Integration,
	type NoteIntegrationConnection,
} from '../../database-types'
import { ENV } from '../../package-env.js'
import { BaseIntegrationProvider } from '../../provider'
import {
	type Channel,
	type MessageData,
	type OAuthCallbackParams,
	type TokenData,
} from '../../types'

const SCOPE = 'https://www.googleapis.com/auth/business.manage'

function credentials() {
	const clientId = ENV.GBP_CLIENT_ID
	const clientSecret = ENV.GBP_CLIENT_SECRET
	if (!clientId || !clientSecret) {
		throw new Error('Google Business Profile is not configured')
	}
	return { clientId, clientSecret }
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
		const { clientId } = credentials()
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
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
		const { clientId, clientSecret } = credentials()
		if (!params.code || !params.redirectUri)
			throw new Error('Missing Google authorization code or redirect URI')
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
		const { clientId, clientSecret } = credentials()
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
