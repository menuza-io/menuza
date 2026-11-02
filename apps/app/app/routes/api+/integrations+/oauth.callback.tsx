import { getUserId } from '@repo/auth'
import { redirectWithToast as _redirectWithToast } from '@repo/common/toast'
import {
	handleOAuthCallback,
	integrationManager,
	integrationOAuthCallbackUrl,
	isPosProvider,
	needsCloverAuthorizeStep,
	peekOAuthState,
	readOAuthAuthorizationCode,
} from '@repo/integrations'
import { type LoaderFunctionArgs, redirectDocument } from 'react-router'
import { ENV } from '#app/utils/env.server.ts'
import { integrationOAuthHandoffCookie } from '#app/utils/integrations/oauth-redirect.server.ts'
import {
	clearIntegrationOAuthState,
	readIntegrationOAuthState,
	sameState,
} from '#app/utils/integrations/oauth-state.server.ts'
import {
	clearPosOAuthAttempt,
	hasPosOAuthAttempt,
	markPosOAuthAttempt,
} from '#app/utils/integrations/pos-oauth.server.ts'
import { posOAuthCallbackUrl } from '#app/utils/integrations/pos-connect.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { requireOrganizationAdmin } from '#app/utils/organization/require-org-admin.server.ts'

async function clearHeaders() {
	const headers = new Headers()
	headers.append('Set-Cookie', await clearIntegrationOAuthState())
	headers.append('Set-Cookie', await clearPosOAuthAttempt())
	return headers
}

async function withClearedCookies(response: Response) {
	const headers = new Headers(response.headers)
	for (const cookie of (await clearHeaders()).getSetCookie()) {
		headers.append('Set-Cookie', cookie)
	}
	return new Response(response.body, { status: response.status, headers })
}

/**
 * Finishes an integration sign-in, but only the one this browser started, for
 * this signed-in member: the hand-off cookie (`oauth-state.server.ts`) holds
 * the state, provider, member and organization, and the callback is accepted
 * only when the state the provider echoes matches it. The organization comes
 * from that record, never from the callback URL.
 */
export async function loader(args: LoaderFunctionArgs) {
	const { request } = args
	const url = new URL(request.url)
	const code = readOAuthAuthorizationCode(url)
	const saved = await readIntegrationOAuthState(request)
	const userId = await getUserId(request)

	if (!saved || !userId || saved.userId !== userId) {
		if (!saved && needsCloverAuthorizeStep(url, code)) {
			return withClearedCookies(
				await _redirectWithToast('/', {
					title: 'Connect from Menuza',
					description:
						'Open Menuza while signed in, go to Settings → Integrations, and click Connect on Clover. App Market installs must use the same redirect URI as your Clover developer app.',
					type: 'error',
				}),
			)
		}
		throw new Response('This connection was not started here.', {
			status: 400,
			headers: await clearHeaders(),
		})
	}

	// OAuth 2.0 providers echo `state`; Trello (OAuth 1.0a) echoes its request
	// token instead; a POS provider such as Clover echoes neither, so the state
	// kept for this browser stands in for it.
	let echoed =
		url.searchParams.get('state') || url.searchParams.get('oauth_token') || ''
	if (!echoed && isPosProvider(saved.provider)) echoed = saved.state
	const providerParam = url.searchParams.get('provider')
	if (
		!echoed ||
		!sameState(echoed, saved.state) ||
		(providerParam && providerParam !== saved.provider)
	) {
		throw new Response('This connection does not match.', {
			status: 400,
			headers: await clearHeaders(),
		})
	}

	const organization = await requireUserOrganization(request, saved.orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	if (isPosProvider(saved.provider)) {
		await requireOrganizationAdmin(request, organization.id)
	}

	const stateData = peekOAuthState(saved.state)
	const back =
		stateData?.redirectUrl ?? `/${organization.slug}/settings/integrations`

	// Clover's App Market launch lands here with a merchant id and no code yet:
	// send the merchant on to the authorization step, once.
	if (
		!code &&
		saved.provider === 'clover' &&
		stateData &&
		needsCloverAuthorizeStep(url, code)
	) {
		if (!(await hasPosOAuthAttempt(request))) {
			try {
				const redirectUri = posOAuthCallbackUrl(request)
				const { authUrl, state: freshState } =
					await integrationManager.initiateOAuth(
						organization.id,
						saved.provider,
						redirectUri,
						{
							oauthRedirectUri: redirectUri,
							redirectUrl: stateData.redirectUrl,
							organizationLocationId: stateData.organizationLocationId,
							merchantId: url.searchParams.get('merchant_id') ?? undefined,
						},
					)
				const headers = new Headers()
				headers.append(
					'Set-Cookie',
					await integrationOAuthHandoffCookie(
						request,
						organization.id,
						saved.provider,
						freshState,
					),
				)
				headers.append('Set-Cookie', await markPosOAuthAttempt())
				return redirectDocument(authUrl, { headers })
			} catch (error) {
				console.error(
					'Failed to start Clover authorize from launch callback:',
					error,
				)
			}
		}
	}

	if (!code && saved.provider === 'clover') {
		return withClearedCookies(
			await _redirectWithToast(back, {
				title: 'Clover connection incomplete',
				description:
					'Clover did not return an authorization code. In the Clover Developer Dashboard, set Site URL and Alternate Launch Path to your app origin. Redirect URI must be exactly: ' +
					integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', request),
				type: 'error',
			}),
		)
	}

	// The shared handler reads the state and provider from the query string.
	if (!url.searchParams.get('state') && !url.searchParams.get('oauth_token')) {
		url.searchParams.set('state', saved.state)
	}
	url.searchParams.set('provider', saved.provider)
	const scoped = new Request(url.toString(), {
		method: 'GET',
		headers: request.headers,
	})

	const response = await handleOAuthCallback(
		{ ...args, request: scoped },
		{
			organization,
			redirectWithToast: async (to, toast) =>
				_redirectWithToast(to, {
					...toast,
					type: toast.type as 'message' | 'success' | 'error',
				}),
		},
	)

	return withClearedCookies(response)
}
