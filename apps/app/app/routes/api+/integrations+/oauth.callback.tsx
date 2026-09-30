import { requireUserId } from '@repo/auth'
import { redirectWithToast as _redirectWithToast } from '@repo/common/toast'
import {
	handleOAuthCallback,
	integrationManager,
	integrationOAuthCallbackUrl,
	needsCloverAuthorizeStep,
	peekOAuthState,
	readOAuthAuthorizationCode,
	readOAuthStateFromRequest,
	type OAuthState,
} from '@repo/integrations'
import { type LoaderFunctionArgs, redirectDocument } from 'react-router'
import { ENV } from '#app/utils/env.server.ts'
import { posOAuthCallbackUrl } from '#app/utils/integrations/pos-connect.server.ts'
import {
	clearPosOAuthAttempt,
	clearPosOAuthState,
	hasPosOAuthAttempt,
	markPosOAuthAttempt,
	readPosOAuthState,
	serializePosOAuthState,
} from '#app/utils/integrations/pos-oauth.server.ts'
import { requireOrganizationAdmin } from '#app/utils/organization/require-org-admin.server.ts'

async function clearOAuthCookies(response: Response) {
	const headers = new Headers(response.headers)
	headers.append('Set-Cookie', await clearPosOAuthState())
	headers.append('Set-Cookie', await clearPosOAuthAttempt())
	return new Response(response.body, { status: response.status, headers })
}

export async function loader(args: LoaderFunctionArgs) {
	const url = new URL(args.request.url)
	const code = readOAuthAuthorizationCode(url)
	const cookieState = await readPosOAuthState(args.request)
	const urlState = url.searchParams.get('state')
	const { state, source: stateSource } = readOAuthStateFromRequest(
		url,
		cookieState,
	)

	if (code && !urlState && !cookieState) {
		return clearOAuthCookies(
			await _redirectWithToast('/', {
				title: 'Integration failed',
				description:
					'Missing OAuth state. Start the connection from Settings → Integrations and try again.',
				type: 'error',
			}),
		)
	}

	let request = args.request
	const effectiveState = urlState ?? (code ? cookieState : state)
	if (!url.searchParams.get('state') && effectiveState) {
		url.searchParams.set('state', effectiveState)
		request = new Request(url.toString(), {
			method: 'GET',
			headers: args.request.headers,
		})
	}

	console.info(
		`[oauth-callback] stateSource=${stateSource} code=${code ? 'yes' : 'no'} keys=${[...url.searchParams.keys()].join(',') || 'none'}`,
	)

	let stateData: OAuthState | null = effectiveState
		? peekOAuthState(effectiveState)
		: null
	if (stateData?.organizationId) {
		try {
			await requireOrganizationAdmin(request, stateData.organizationId)
		} catch (error) {
			return clearOAuthCookies(
				await _redirectWithToast('/', {
					title: 'Integration failed',
					description:
						error instanceof Error ? error.message : 'Authorization failed',
					type: 'error',
				}),
			)
		}
	}

	if (!url.searchParams.get('provider') && stateData?.providerName) {
		url.searchParams.set('provider', stateData.providerName)
		request = new Request(url.toString(), {
			method: 'GET',
			headers: args.request.headers,
		})
	}

	const redirectUri = posOAuthCallbackUrl(args.request)
	if (
		!code &&
		stateData?.providerName &&
		needsCloverAuthorizeStep(url, code) &&
		stateData.providerName === 'clover'
	) {
		const alreadyRetried = await hasPosOAuthAttempt(args.request)
		if (!alreadyRetried) {
			try {
				const merchantId = url.searchParams.get('merchant_id')
				const { authUrl, state: freshState } =
					await integrationManager.initiateOAuth(
						stateData.organizationId,
						stateData.providerName,
						redirectUri,
						{
							oauthRedirectUri: redirectUri,
							redirectUrl: stateData.redirectUrl,
							organizationLocationId: stateData.organizationLocationId,
							merchantId: merchantId ?? undefined,
						},
					)
				const headers = new Headers()
				headers.append('Set-Cookie', await serializePosOAuthState(freshState))
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

	if (!code && !stateData && needsCloverAuthorizeStep(url, code)) {
		return clearOAuthCookies(
			await _redirectWithToast('/', {
				title: 'Connect from Menuza',
				description:
					'Open Menuza while signed in, go to Settings → Integrations, and click Connect on Clover. App Market installs must use the same redirect URI as your Clover developer app.',
				type: 'error',
			}),
		)
	}

	if (!code && stateData?.providerName === 'clover') {
		return clearOAuthCookies(
			await _redirectWithToast(stateData.redirectUrl ?? '/', {
				title: 'Clover connection incomplete',
				description:
					'Clover did not return an authorization code. In the Clover Developer Dashboard, set Site URL and Alternate Launch Path to your app origin. Redirect URI must be exactly: ' +
					integrationOAuthCallbackUrl(ENV.BASE_URL ?? '', args.request),
				type: 'error',
			}),
		)
	}

	const response = await handleOAuthCallback(
		{ ...args, request },
		{
			requireUserId,
			redirectWithToast: async (
				targetUrl: string,
				options: { title: string; description: string; type: string },
			) => {
				return await _redirectWithToast(targetUrl, {
					title: options.title,
					description: options.description,
					type: options.type as 'message' | 'success' | 'error',
				})
			},
		},
	)

	return clearOAuthCookies(response)
}
