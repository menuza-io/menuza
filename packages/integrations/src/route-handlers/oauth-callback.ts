import { invariant } from '@epic-web/invariant'
import {
	Integration as IntegrationTable,
	Organization as OrganizationTable,
	and,
	db,
	eq,
} from '@repo/database'
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
	requireUserId: (request: Request) => Promise<string>
	redirectWithToast: (
		url: string,
		options: { title: string; description: string; type: string },
	) => Response | Promise<Response>
}

export async function handleOAuthCallback(
	{ request }: LoaderFunctionArgs,
	deps: OAuthCallbackDependencies,
) {
	await deps.requireUserId(request)

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
		return deps.redirectWithToast(
			state ? (peekOAuthState(state)?.redirectUrl ?? '/') : '/',
			{
				title: 'Integration failed',
				description: `Failed to connect: ${errorMsg}`,
				type: 'error',
			},
		)
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
		return deps.redirectWithToast('/', {
			title: 'Integration failed',
			description,
			type: 'error',
		})
	}

	if (!providerName) {
		return deps.redirectWithToast('/', {
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
		const integration = await oauthFlow.complete(providerName, {
			organizationId: '',
			code: code || '',
			state: state || '',
			error: error || undefined,
			errorDescription: errorDescription || undefined,
			oauthToken: oauthToken || undefined,
			oauthVerifier: oauthVerifier || undefined,
			merchantId: merchantId || undefined,
			redirectUri,
		})

		const [organization] = await db
			.select({ slug: OrganizationTable.slug })
			.from(OrganizationTable)
			.where(eq(OrganizationTable.id, integration.organizationId))
			.limit(1)

		invariant(organization, 'Organization not found')

		const successPath =
			postConnectRedirect ??
			(isPosProvider(providerName)
				? `/${organization.slug}/settings/integrations`
				: `/${organization.slug}/settings`)
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
			let stateData = state ? peekOAuthState(state) : null
			if (stateData) {
				const [existing] = await db
					.select({ id: IntegrationTable.id })
					.from(IntegrationTable)
					.where(
						and(
							eq(IntegrationTable.organizationId, stateData.organizationId),
							eq(IntegrationTable.providerName, providerName),
							eq(IntegrationTable.isActive, true),
						),
					)
					.limit(1)

				if (existing) {
					const [organization] = await db
						.select({ slug: OrganizationTable.slug })
						.from(OrganizationTable)
						.where(eq(OrganizationTable.id, stateData.organizationId))
						.limit(1)
					return deps.redirectWithToast(
						organization ? `/${organization.slug}/settings/integrations` : '/',
						{
							title: 'Integration connected',
							description: 'This connection was already completed.',
							type: 'success',
						},
					)
				}
			}

			return deps.redirectWithToast('/', {
				title: 'Connection not completed',
				description: 'Please try connecting again.',
				type: 'error',
			})
		}

		console.error('OAuth callback error:', caught)

		return deps.redirectWithToast('/', {
			title: 'Integration failed',
			description: `Failed to complete connection: ${errorMessage}`,
			type: 'error',
		})
	}
}
