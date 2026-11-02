import { providerRegistry } from './provider'
import { integrationManager } from './integration-manager'
import { OAuthStateManager } from './oauth-manager'
import { type OAuthCallbackParams } from './types'
import { type Integration } from './database-types'

/**
 * Starting and finishing a provider sign-in. The app binds the two halves to
 * the browser and member who started it: it keeps the `state` returned by
 * `start` in its own short-lived cookie, checks it against the callback, and
 * passes the organization from that record to `complete`, never one taken
 * from the callback URL.
 */
class OAuthFlow {
	/**
	 * Start OAuth flow for a provider. `state` is the value the provider will
	 * send back to the callback: the `state` parameter (OAuth 2.0), or the
	 * request token (`oauth_token`, Trello's OAuth 1.0a).
	 */
	async start(
		organizationId: string,
		providerName: string,
		redirectUri: string,
		additionalParams?: Record<string, any>,
	): Promise<{ authUrl: string; state: string }> {
		const provider = providerRegistry.get(providerName)
		const authUrl = await provider.getAuthUrl(
			organizationId,
			redirectUri,
			additionalParams,
		)

		const url = new URL(authUrl)
		const state =
			url.searchParams.get('state') ?? url.searchParams.get('oauth_token')
		if (!state) {
			throw new Error(`${providerName} returned no state to check on return`)
		}

		return { authUrl, state }
	}

	/**
	 * Complete OAuth flow by handling callback. `params.organizationId` must be
	 * the organization the app verified for this browser and member; the
	 * provider's state has to belong to it too.
	 */
	async complete(
		providerName: string,
		params: OAuthCallbackParams,
	): Promise<Integration> {
		const organizationId = params.organizationId
		if (!organizationId) {
			throw new Error('Missing organization for the OAuth callback')
		}

		const isOAuth1 = params.oauthToken && params.oauthVerifier

		if (isOAuth1) {
			// OAuth 1.0a flow (Trello) - the request token carries the organization
			const provider = providerRegistry.get(providerName)
			if (!provider || !('getRequestTokenContext' in provider)) {
				throw new Error(
					`${providerName} provider not found or does not support OAuth 1.0a`,
				)
			}

			const tokenContext = await (provider as any).getRequestTokenContext(
				params.oauthToken!,
			)

			if (!tokenContext) {
				throw new Error(
					'OAuth request token not found or expired. Please restart the authorization process.',
				)
			}

			if (tokenContext.organizationId !== organizationId) {
				throw new Error('Organization mismatch in OAuth state')
			}
		} else {
			// Standard OAuth 2.0 state validation. The nonce is not consumed here:
			// the provider validates (and consumes) the same state again in
			// `handleCallback`, which would otherwise count as a replay.
			let stateData
			try {
				stateData = OAuthStateManager.validateState(params.state, false)
			} catch (error) {
				throw new Error(`Invalid OAuth state: ${error}`)
			}

			if (stateData.providerName !== providerName) {
				throw new Error('Provider name mismatch in OAuth state')
			}

			if (stateData.organizationId !== organizationId) {
				throw new Error('Organization mismatch in OAuth state')
			}
		}

		const provider = providerRegistry.get(providerName)

		const handleParams = isOAuth1
			? {
					...params,
					code: params.oauthVerifier!,
					state: params.state || `trello-oauth1-${Date.now()}`,
				}
			: params

		const tokenData = await provider.handleCallback(handleParams)

		const integration = await integrationManager.createIntegration({
			organizationId,
			providerName,
			tokenData,
			config: {},
		})

		await integrationManager.logIntegrationActivity(
			integration.id,
			'oauth_complete',
			'success',
			{ provider: providerName },
		)

		return integration
	}
}

export const oauthFlow = new OAuthFlow()
