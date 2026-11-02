import { oauthFlow } from '../oauth-flow'
import { type LoaderFunctionArgs } from 'react-router'

export interface OAuthCallbackDependencies {
	/**
	 * The organization this sign-in was started for. The app takes it from its
	 * own record of the hand-off, after checking that the callback reached the
	 * same browser and signed-in member, that the echoed state matches, and that
	 * the member may still manage integrations. Never from the callback URL.
	 */
	organization: { id: string; slug: string }
	redirectWithToast: (
		url: string,
		options: { title: string; description: string; type: string },
	) => Response | Promise<Response>
}

/**
 * Shared OAuth callback handler for integration providers.
 * Handles both OAuth 1.0a (Trello) and OAuth 2.0 flows, and returns the
 * member to the organization's integrations settings.
 *
 * @param request - The incoming request
 * @param deps - Dependencies (verified organization, toast)
 * @returns Redirect response with toast message
 */
export async function handleOAuthCallback(
	{ request }: LoaderFunctionArgs,
	deps: OAuthCallbackDependencies,
) {
	const back = `/${deps.organization.slug}/settings/integrations`
	const url = new URL(request.url)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const error = url.searchParams.get('error')
	const errorDescription = url.searchParams.get('error_description')
	const oauthToken = url.searchParams.get('oauth_token')
	const oauthVerifier = url.searchParams.get('oauth_verifier')
	const providerName = url.searchParams.get('provider')

	if (error) {
		const errorMsg = errorDescription || error
		console.error('OAuth error:', errorMsg)
		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description: `Failed to connect: ${errorMsg}`,
			type: 'error',
		})
	}

	const isOAuth1 = oauthToken && oauthVerifier
	const isOAuth2 = code && state

	if (!isOAuth1 && !isOAuth2) {
		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description: 'Missing required OAuth parameters',
			type: 'error',
		})
	}

	if (!providerName) {
		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description: 'Missing provider parameter',
			type: 'error',
		})
	}

	try {
		await oauthFlow.complete(providerName, {
			organizationId: deps.organization.id,
			code: code || '',
			state: state || '',
			error: error || undefined,
			errorDescription: errorDescription || undefined,
			oauthToken: oauthToken || undefined,
			oauthVerifier: oauthVerifier || undefined,
		})

		return deps.redirectWithToast(back, {
			title: 'Integration connected',
			description: `Successfully connected to ${providerName}`,
			type: 'success',
		})
	} catch (error) {
		console.error('OAuth callback error:', error)
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error occurred'

		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description: `Failed to complete connection: ${errorMessage}`,
			type: 'error',
		})
	}
}
