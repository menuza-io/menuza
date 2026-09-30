import { type OAuthCallbackParams, type TokenData } from '../../types'
import { PosError } from '../errors.ts'
import { squareOAuthAuthorizeOrigin } from '../credentials.ts'
import { getJson, postForm, requirePosAppCredentials } from '../oauth-shared.ts'
import { BasePosProvider } from './base.ts'

const SCOPES = [
	'MERCHANT_PROFILE_READ',
	'ITEMS_READ',
	'ITEMS_WRITE',
	'INVENTORY_READ',
].join(' ')

type SquareTokenResponse = {
	access_token?: string
	refresh_token?: string
	expires_at?: string
	merchant_id?: string
}

export class SquareProvider extends BasePosProvider {
	readonly provider = 'square' as const
	readonly name = 'square'
	readonly displayName = 'Square'
	readonly description =
		'Keep your Square items, categories and modifiers in step with your menu'
	readonly icon = 'square'

	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const app = requirePosAppCredentials('square')
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
		const params = new URLSearchParams({
			client_id: app.clientId,
			scope: SCOPES,
			session: 'false',
			state,
			redirect_uri: redirectUri,
		})
		const authorizeOrigin = squareOAuthAuthorizeOrigin(app.clientId)
		return `${authorizeOrigin}/oauth2/authorize?${params.toString()}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const app = requirePosAppCredentials('square')
		if (params.error) {
			throw new PosError(
				`Square returned an error: ${params.errorDescription || params.error}`,
				400,
			)
		}
		if (!params.code) {
			throw new PosError('Square did not return an authorization code.', 400)
		}
		const stateData = this.parseOAuthState(params.state)
		const redirectUri =
			params.redirectUri ??
			(typeof stateData.oauthRedirectUri === 'string'
				? stateData.oauthRedirectUri
				: '')

		const token = await postForm<SquareTokenResponse>(
			`${app.apiBaseUrl}/oauth2/token`,
			{
				client_id: app.clientId,
				client_secret: app.clientSecret,
				code: params.code,
				grant_type: 'authorization_code',
				redirect_uri: redirectUri,
			},
		)
		if (!token.access_token) {
			throw new PosError('Square did not return an access token.')
		}

		const locationId = await this.discoverLocationId(
			app.apiBaseUrl,
			token.access_token,
		)

		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: token.expires_at ? new Date(token.expires_at) : undefined,
			scope: SCOPES,
			metadata: {
				merchantId: token.merchant_id ?? locationId,
				locationId,
			},
		}
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const app = requirePosAppCredentials('square')
		const token = await postForm<SquareTokenResponse>(
			`${app.apiBaseUrl}/oauth2/token`,
			{
				client_id: app.clientId,
				client_secret: app.clientSecret,
				refresh_token: refreshToken,
				grant_type: 'refresh_token',
			},
		)
		if (!token.access_token) {
			throw new PosError('Square did not return an access token.')
		}
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: token.expires_at ? new Date(token.expires_at) : undefined,
			scope: SCOPES,
			metadata: {
				merchantId: token.merchant_id,
			},
		}
	}

	private async discoverLocationId(baseUrl: string, accessToken: string) {
		const data = await getJson<{ locations?: { id: string }[] }>(
			`${baseUrl}/v2/locations`,
			accessToken,
		)
		const id = data.locations?.[0]?.id
		if (!id) {
			throw new PosError('Square did not return a location id.', 400)
		}
		return id
	}
}
