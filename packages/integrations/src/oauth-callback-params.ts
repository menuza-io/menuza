import { OAuthStateManager } from './oauth-manager.ts'
import { type OAuthState } from './types.ts'

/** Clover (legacy + v2) may use several query names for the authorization code. */
export function readOAuthAuthorizationCode(url: URL): string | null {
	return (
		url.searchParams.get('code') ??
		url.searchParams.get('authorization_code') ??
		url.searchParams.get('auth_code')
	)
}

export function readOAuthStateFromRequest(
	url: URL,
	cookieState?: string | null,
): { state: string | null; source: 'url' | 'cookie' | 'missing' } {
	const fromUrl = url.searchParams.get('state')
	if (fromUrl) return { state: fromUrl, source: 'url' }
	if (cookieState) return { state: cookieState, source: 'cookie' }
	return { state: null, source: 'missing' }
}

export function peekOAuthState(state: string | null): OAuthState | null {
	if (!state) return null
	try {
		return OAuthStateManager.parseState(state)
	} catch {
		return null
	}
}

/**
 * Clover App Market / Alternate Launch Path often hits the callback with
 * `merchant_id` (and sometimes `client_id`) before an authorization `code`
 * exists. The app must send the merchant to `/oauth/v2/authorize` next.
 */
export function needsCloverAuthorizeStep(
	url: URL,
	code: string | null,
): boolean {
	if (code) return false
	const merchantId = url.searchParams.get('merchant_id')
	const clientId = url.searchParams.get('client_id')
	return Boolean(merchantId || clientId)
}

export function integrationOAuthCallbackUrl(
	baseUrl: string,
	request?: Request,
): string {
	const trimmed = baseUrl.trim().replace(/\/$/, '')
	if (trimmed) {
		return `${trimmed}/api/integrations/oauth/callback`
	}
	if (!request) {
		throw new Error('BASE_URL is not set and no request was provided.')
	}
	const url = new URL(request.url)
	const protocol = url.protocol === 'https:' ? 'https:' : 'http:'
	return `${protocol}//${url.host}/api/integrations/oauth/callback`
}
