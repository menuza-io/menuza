import { and, db, eq, Integration as IntegrationTable } from '@repo/database'
import {
	integrationOAuthCallbackUrl,
	readOAuthAuthorizationCode,
	peekOAuthState,
} from '../oauth-callback-params.ts'
import { oauthFlow } from '../oauth-flow'
import { OAuthStateManager } from '../oauth-manager'
import { ENV } from '../package-env.js'
import { isPosProvider, providerNames, type PosProvider } from '../pos/types.ts'
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
 */
export async function handleOAuthCallback(
	{ request }: LoaderFunctionArgs,
	deps: OAuthCallbackDependencies,
) {
	const back = `/${deps.organization.slug}/settings/integrations`
	const url = new URL(request.url)
	const code = readOAuthAuthorizationCode(url)
	const state = url.searchParams.get('state')
	const error = url.searchParams.get('error')
	const errorDescription = url.searchParams.get('error_description')
	const oauthToken = url.searchParams.get('oauth_token')
	const oauthVerifier = url.searchParams.get('oauth_verifier')
	const merchantId = url.searchParams.get('merchant_id')
	let providerName = url.searchParams.get('provider')
	if (!providerName && state) {
		providerName = peekOAuthState(state)?.providerName ?? null
	}

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
		const received = [...url.searchParams.keys()]
		console.error(
			`OAuth callback is missing parameters. Received query keys: ${received.join(', ') || '(none)'}`,
		)
		const description =
			state && !code
				? `The provider did not return an authorization code (received: ${received.join(', ') || 'none'}). Remove the app and connect again to re-authorize.`
				: `Missing required OAuth parameters (received: ${received.join(', ') || 'none'})`
		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description,
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

	const redirectUri = integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request)

	let postConnectRedirect: string | undefined
	if (state) {
		try {
			postConnectRedirect = (
				await OAuthStateManager.validateState(state, false)
			).redirectUrl
		} catch {
			// Handled in oauthFlow.complete if the state is invalid.
		}
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
			merchantId: merchantId || undefined,
			redirectUri,
		})

		const successPath = postConnectRedirect ?? back
		const label = isPosProvider(providerName)
			? providerNames[providerName as PosProvider]
			: providerName

		return deps.redirectWithToast(successPath, {
			title: 'Integration connected',
			description: `Connected to ${label}. Store details were imported when available.`,
			type: 'success',
		})
	} catch (caught) {
		const errorMessage =
			caught instanceof Error ? caught.message : 'Unknown error occurred'

		if (errorMessage.includes('nonce already consumed')) {
			const stateData = state ? peekOAuthState(state) : null
			if (stateData?.organizationId === deps.organization.id) {
				const [existing] = await db
					.select({ id: IntegrationTable.id })
					.from(IntegrationTable)
					.where(
						and(
							eq(IntegrationTable.organizationId, deps.organization.id),
							eq(IntegrationTable.providerName, providerName),
							eq(IntegrationTable.isActive, true),
						),
					)
					.limit(1)

				if (existing) {
					return deps.redirectWithToast(back, {
						title: 'Integration connected',
						description: 'This connection was already completed.',
						type: 'success',
					})
				}
			}

			return deps.redirectWithToast(back, {
				title: 'Connection not completed',
				description: 'Please try connecting again.',
				type: 'error',
			})
		}

		console.error('OAuth callback error:', caught)

		return deps.redirectWithToast(back, {
			title: 'Integration failed',
			description: `Failed to complete connection: ${errorMessage}`,
			type: 'error',
		})
	}
}
