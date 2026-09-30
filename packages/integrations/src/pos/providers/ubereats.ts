import { type OAuthCallbackParams, type TokenData } from '../../types'
import { PosError } from '../errors.ts'
import {
	fetchUberEatsClientCredentialsToken,
	UBER_EATS_MERCHANT_OAUTH_SCOPE,
	uberTokenEndpoint,
} from '../uber-oauth.ts'
import { getJson, postForm, requirePosAppCredentials } from '../oauth-shared.ts'
import { BasePosProvider } from './base.ts'

type UberTokenResponse = {
	access_token?: string
	refresh_token?: string
	expires_in?: number
	token_type?: string
}

export class UberEatsProvider extends BasePosProvider {
	readonly provider = 'ubereats' as const
	readonly name = 'ubereats'
	readonly displayName = 'Uber Eats'
	readonly description =
		'Keep your Uber Eats delivery menu current with prices and availability'
	readonly icon = 'uber-eats'

	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const app = requirePosAppCredentials('ubereats')
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
		const params = new URLSearchParams({
			client_id: app.clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			scope: UBER_EATS_MERCHANT_OAUTH_SCOPE,
			state,
		})
		return `${app.authorizeBaseUrl}/oauth/v2/authorize?${params.toString()}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const app = requirePosAppCredentials('ubereats')
		if (params.error) {
			throw new PosError(
				`Uber Eats returned an error: ${params.errorDescription || params.error}`,
				400,
			)
		}
		if (!params.code) {
			throw new PosError('Uber Eats did not return an authorization code.', 400)
		}
		const stateData = this.parseOAuthState(params.state)
		const redirectUri =
			params.redirectUri ??
			(typeof stateData.oauthRedirectUri === 'string'
				? stateData.oauthRedirectUri
				: '')

		const token = await postForm<UberTokenResponse>(uberTokenEndpoint(app), {
			client_id: app.clientId,
			client_secret: app.clientSecret,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri,
			code: params.code,
		})
		if (!token.access_token) {
			throw new PosError('Uber Eats did not return an access token.')
		}

		const storeId = await this.discoverStoreId(
			app.apiBaseUrl,
			token.access_token,
		)

		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: token.expires_in
				? new Date(Date.now() + token.expires_in * 1000)
				: undefined,
			scope: UBER_EATS_MERCHANT_OAUTH_SCOPE,
			metadata: { merchantId: storeId, locationId: storeId },
		}
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const app = requirePosAppCredentials('ubereats')
		const token = await postForm<UberTokenResponse>(uberTokenEndpoint(app), {
			client_id: app.clientId,
			client_secret: app.clientSecret,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		})
		if (!token.access_token) {
			throw new PosError('Uber Eats did not return an access token.')
		}
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: token.expires_in
				? new Date(Date.now() + token.expires_in * 1000)
				: undefined,
			scope: UBER_EATS_MERCHANT_OAUTH_SCOPE,
		}
	}

	/** Client-credentials token for menu APIs (merchant OAuth cannot call these). */
	async getApiAccessToken(): Promise<string> {
		return fetchUberEatsClientCredentialsToken(
			requirePosAppCredentials('ubereats'),
		)
	}

	private async discoverStoreId(apiBaseUrl: string, accessToken: string) {
		const data = await getJson<{ stores?: { store_id: string }[] }>(
			`${apiBaseUrl}/v1/eats/stores`,
			accessToken,
		)
		const id = data.stores?.[0]?.store_id
		if (!id) {
			throw new PosError('Uber Eats did not return a store id.', 400)
		}
		return id
	}
}
