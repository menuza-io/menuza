import { type OAuthCallbackParams, type TokenData } from '../../types'
import { PosError } from '../errors.ts'
import { getJson, postForm, requirePosAppCredentials } from '../oauth-shared.ts'
import { BasePosProvider } from './base.ts'

type ToastTokenResponse = {
	accessToken?: string
	refreshToken?: string
	expiresIn?: number
	tokenType?: string
}

export class ToastProvider extends BasePosProvider {
	readonly provider = 'toast' as const
	readonly name = 'toast'
	readonly displayName = 'Toast'
	readonly description =
		'Bring your Toast menu into one workspace and push sold-out items back'
	readonly icon = 'toast'

	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const app = requirePosAppCredentials('toast')
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
		const params = new URLSearchParams({
			client_id: app.clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			state,
		})
		return `${app.authorizeBaseUrl}/authentication/v1/oauth/authorize?${params.toString()}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const app = requirePosAppCredentials('toast')
		if (params.error) {
			throw new PosError(
				`Toast returned an error: ${params.errorDescription || params.error}`,
				400,
			)
		}
		if (!params.code) {
			throw new PosError('Toast did not return an authorization code.', 400)
		}
		const stateData = this.parseOAuthState(params.state)
		const redirectUri =
			params.redirectUri ??
			(typeof stateData.oauthRedirectUri === 'string'
				? stateData.oauthRedirectUri
				: '')

		const token = await postForm<ToastTokenResponse>(
			`${app.apiBaseUrl}/authentication/v1/oauth/token`,
			{
				client_id: app.clientId,
				client_secret: app.clientSecret,
				grant_type: 'authorization_code',
				code: params.code,
				redirect_uri: redirectUri,
			},
		)
		const accessToken = token.accessToken
		if (!accessToken) {
			throw new PosError('Toast did not return an access token.')
		}

		const restaurantGuid = await this.discoverRestaurantGuid(
			app.apiBaseUrl,
			accessToken,
		)

		return {
			accessToken,
			refreshToken: token.refreshToken,
			expiresAt: token.expiresIn
				? new Date(Date.now() + token.expiresIn * 1000)
				: undefined,
			scope: 'restaurant',
			metadata: { merchantId: restaurantGuid, locationId: restaurantGuid },
		}
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const app = requirePosAppCredentials('toast')
		const token = await postForm<ToastTokenResponse>(
			`${app.apiBaseUrl}/authentication/v1/oauth/token`,
			{
				client_id: app.clientId,
				client_secret: app.clientSecret,
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			},
		)
		if (!token.accessToken) {
			throw new PosError('Toast did not return an access token.')
		}
		return {
			accessToken: token.accessToken,
			refreshToken: token.refreshToken ?? refreshToken,
			expiresAt: token.expiresIn
				? new Date(Date.now() + token.expiresIn * 1000)
				: undefined,
			scope: 'restaurant',
		}
	}

	private async discoverRestaurantGuid(
		apiBaseUrl: string,
		accessToken: string,
	) {
		const data = await getJson<{
			restaurants?: { restaurantGuid: string }[]
		}>(`${apiBaseUrl}/authentication/v1/restaurants`, accessToken)
		const id = data.restaurants?.[0]?.restaurantGuid
		if (!id) throw new PosError('Toast did not return a restaurant id.', 400)
		return id
	}
}
