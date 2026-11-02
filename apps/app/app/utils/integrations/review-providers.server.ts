import {
	integrationManager,
	integrationOAuthCallbackUrl,
	type ReviewProviderName,
} from '@repo/integrations'
import { ENV } from '#app/utils/env.server.ts'
import { redirectToProviderWithHandoff } from '#app/utils/integrations/oauth-redirect.server.ts'

export async function connectReviewProvider(
	request: Request,
	organizationId: string,
	providerName: ReviewProviderName,
	afterRedirectUrl: string,
	organizationLocationId: string,
) {
	const redirectUri = integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request)
	const { authUrl, state } = await integrationManager.initiateOAuth(
		organizationId,
		providerName,
		redirectUri,
		{
			redirectUrl: afterRedirectUrl,
			organizationLocationId,
		},
	)
	return redirectToProviderWithHandoff(
		request,
		organizationId,
		providerName,
		authUrl,
		state,
	)
}

export function connectGoogleBusinessProfile(
	request: Request,
	organizationId: string,
	afterRedirectUrl: string,
	organizationLocationId: string,
) {
	return connectReviewProvider(
		request,
		organizationId,
		'google-business-profile',
		afterRedirectUrl,
		organizationLocationId,
	)
}
