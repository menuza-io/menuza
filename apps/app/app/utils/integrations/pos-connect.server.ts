import {
	connectPosProvider,
	hasAppCredentials,
	integrationOAuthCallbackUrl,
	isPosProvider,
	isPosSandboxConnectAllowed,
	providerUsesMerchantOAuth,
	startPosOAuth,
} from '@repo/integrations'
import { redirectDocument } from 'react-router'
import { ENV } from '#app/utils/env.server.ts'
import { serializePosOAuthState } from '#app/utils/integrations/pos-oauth.server.ts'

export function posOAuthCallbackUrl(request: Request): string {
	return integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request)
}

/**
 * Connect a POS/delivery platform: merchant OAuth when app credentials exist,
 * otherwise the in-process sandbox (MSW).
 */
export async function connectPosPlatform(
	request: Request,
	organizationId: string,
	providerName: string,
	options?: {
		afterRedirectUrl?: string
		organizationLocationId?: string
		menuzaLocationId?: string
		doorDashStoreId?: string
	},
) {
	if (!isPosProvider(providerName)) {
		throw new Error('Unknown platform.')
	}

	if (!hasAppCredentials(providerName) && !isPosSandboxConnectAllowed()) {
		throw new Error(
			'Configure platform credentials to connect in production, or use a development environment for sandbox mode.',
		)
	}

	if (
		hasAppCredentials(providerName) &&
		providerUsesMerchantOAuth(providerName)
	) {
		const redirectUri = posOAuthCallbackUrl(request)
		const { authUrl, state } = await startPosOAuth(
			organizationId,
			providerName,
			redirectUri,
			{
				redirectUrl: options?.afterRedirectUrl,
				organizationLocationId: options?.organizationLocationId,
			},
		)
		return redirectDocument(authUrl, {
			headers: { 'Set-Cookie': await serializePosOAuthState(state) },
		})
	}

	const organizationLocationId = options?.organizationLocationId?.trim()
	if (!organizationLocationId) {
		throw new Error('Select a restaurant location before connecting.')
	}

	await connectPosProvider(
		organizationId,
		providerName,
		organizationLocationId,
		{
			doorDash:
				providerName === 'doordash' && options?.doorDashStoreId
					? {
							menuzaLocationId: organizationLocationId,
							doorDashStoreId: options.doorDashStoreId,
						}
					: undefined,
		},
	)
	return null
}
