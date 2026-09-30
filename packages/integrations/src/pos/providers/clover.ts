import { type OAuthCallbackParams, type TokenData } from '../../types'
import { requirePosAppCredentials } from '../oauth-shared.ts'
import { PosError } from '../errors.ts'
import { BasePosProvider } from './base.ts'

type CloverTokenResponse = {
	access_token?: string
	access_token_expiration?: number
	refresh_token?: string
	refresh_token_expiration?: number
}

/**
 * Clover provider. Supports the v2/OAuth flow (client id + secret) so a merchant
 * can authorize the app; the resulting access/refresh token pair is encrypted
 * and stored on the connection, and the merchant id is read back from the API.
 */
export class CloverProvider extends BasePosProvider {
	readonly provider = 'clover' as const
	readonly name = 'clover'
	readonly displayName = 'Clover'
	readonly description =
		'Sync your Clover catalog of items, categories and modifiers with your menu'
	readonly icon = 'clover'

	async getAuthUrl(
		organizationId: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<string> {
		const app = this.appCredentials()
		const state =
			typeof additionalParams?.state === 'string'
				? additionalParams.state
				: this.generateOAuthState(organizationId, additionalParams)
		const params = new URLSearchParams({
			client_id: app.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			state,
		})
		// When Clover launches the app from the dashboard / App Market it often
		// sends merchant_id first; passing it here skips re-selecting the merchant.
		const merchantId = additionalParams?.merchantId
		if (typeof merchantId === 'string' && merchantId.trim()) {
			params.set('merchant_id', merchantId.trim())
		}
		return `${app.authorizeBaseUrl}/oauth/v2/authorize?${params.toString()}`
	}

	async handleCallback(params: OAuthCallbackParams): Promise<TokenData> {
		const app = this.appCredentials()
		if (params.error) {
			throw new PosError(
				`Clover returned an error: ${params.errorDescription || params.error}`,
				400,
			)
		}
		if (!params.code) {
			throw new PosError('Clover did not return an authorization code.', 400)
		}
		const stateData = this.parseOAuthState(params.state)
		const redirectUri =
			params.redirectUri ??
			(typeof stateData.oauthRedirectUri === 'string'
				? stateData.oauthRedirectUri
				: undefined)

		const tokenBody: Record<string, string> = {
			client_id: app.clientId,
			client_secret: app.clientSecret,
			code: params.code,
		}
		if (redirectUri) tokenBody.redirect_uri = redirectUri

		const token = await this.exchangeToken(
			app.apiBaseUrl,
			'/oauth/v2/token',
			tokenBody,
		)
		// Clover includes the merchant id on the callback URL; only look it up when
		// it is missing.
		let merchantId = params.merchantId?.trim() ?? ''
		if (!merchantId) {
			merchantId = await this.discoverMerchantId(
				app.apiBaseUrl,
				token.access_token!,
			)
		}

		return {
			accessToken: token.access_token!,
			refreshToken: token.refresh_token,
			expiresAt: this.expiresAt(token.access_token_expiration),
			scope: 'merchant',
			metadata: { merchantId },
		}
	}

	async refreshToken(refreshToken: string): Promise<TokenData> {
		const app = this.appCredentials()
		const token = await this.exchangeToken(
			app.apiBaseUrl,
			'/oauth/v2/refresh',
			{
				client_id: app.clientId,
				client_secret: app.clientSecret,
				refresh_token: refreshToken,
			},
		)
		return {
			accessToken: token.access_token!,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: this.expiresAt(token.access_token_expiration),
			scope: 'merchant',
		}
	}

	private appCredentials() {
		return requirePosAppCredentials('clover')
	}

	private expiresAt(raw?: number): Date | undefined {
		if (!raw) return undefined
		// Clover normally returns Unix seconds. Millisecond timestamps are larger.
		if (raw > 1_000_000_000_000) return new Date(raw)
		// Small values are a TTL in seconds, not an epoch.
		if (raw < 1_000_000_000) return new Date(Date.now() + raw * 1000)
		return new Date(raw * 1000)
	}

	private async exchangeToken(
		baseUrl: string,
		path: string,
		body: Record<string, string>,
	): Promise<CloverTokenResponse> {
		const response = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify(body),
		})
		if (!response.ok) {
			throw new PosError(
				`Clover token request failed (${response.status}).`,
				response.status,
			)
		}
		const token = (await response.json()) as CloverTokenResponse
		if (!token.access_token) {
			throw new PosError('Clover did not return an access token.')
		}
		return token
	}

	// The token response has no merchant id; the merchant a token belongs to is
	// discovered by listing the merchants it can access.
	private async discoverMerchantId(
		baseUrl: string,
		accessToken: string,
	): Promise<string> {
		const response = await fetch(`${baseUrl}/v3/merchants?limit=1`, {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: 'application/json',
			},
		})
		if (!response.ok) {
			throw new PosError(
				`Connected to Clover but could not read the merchant (${response.status}).`,
				response.status,
			)
		}
		const data = (await response.json()) as {
			elements?: { id?: string }[]
		}
		const id = data.elements?.[0]?.id
		if (!id) throw new PosError('Clover did not return a merchant id.')
		return id
	}
}
