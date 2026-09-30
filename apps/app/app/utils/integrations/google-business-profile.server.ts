import {
	integrationManager,
	integrationOAuthCallbackUrl,
} from '@repo/integrations'
import { redirectDocument } from 'react-router'
import { ENV } from '#app/utils/env.server.ts'

export async function connectGoogleBusinessProfile(
	request: Request,
	organizationId: string,
	afterRedirectUrl: string,
	organizationLocationId: string,
) {
	const redirectUri = integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request)
	const { authUrl } = await integrationManager.initiateOAuth(
		organizationId,
		'google-business-profile',
		redirectUri,
		{
			redirectUrl: afterRedirectUrl,
			organizationLocationId,
		},
	)
	return redirectDocument(authUrl)
}
