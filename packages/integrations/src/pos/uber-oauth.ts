/**
 * Uber Eats uses two OAuth grant types (see Uber Eats authentication guide):
 * - `authorization_code` + `eats.pos_provisioning` for merchant connect / store list
 * - `client_credentials` + `eats.store` for menu and store API calls after provisioning
 */

import { uberOAuthOrigin, type PosAppCredentials } from './credentials.ts'
import { postForm } from './oauth-shared.ts'

export const UBER_EATS_MERCHANT_OAUTH_SCOPE = 'eats.pos_provisioning'
export const UBER_EATS_API_SCOPES = 'eats.store'

type UberTokenResponse = {
	access_token?: string
	refresh_token?: string
	expires_in?: number
}

export function uberTokenEndpoint(
	app: Pick<PosAppCredentials, 'authorizeBaseUrl'>,
) {
	return `${uberOAuthOrigin(app.authorizeBaseUrl)}/oauth/v2/token`
}

/** Application token for menu/order endpoints (not the merchant OAuth token). */
export async function fetchUberEatsClientCredentialsToken(
	app: PosAppCredentials,
	scopes: string = UBER_EATS_API_SCOPES,
): Promise<string> {
	const token = await postForm<UberTokenResponse>(uberTokenEndpoint(app), {
		client_id: app.clientId,
		client_secret: app.clientSecret,
		grant_type: 'client_credentials',
		scope: scopes,
	})
	if (!token.access_token) {
		throw new Error('Uber Eats did not return a client credentials token.')
	}
	return token.access_token
}
