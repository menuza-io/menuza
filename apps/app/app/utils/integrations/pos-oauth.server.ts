import { createCookie } from 'react-router'

/**
 * Carries the signed OAuth state across the provider redirect for providers
 * that do not echo `state` on the callback (e.g. Clover, whose callback is
 * `?merchant_id=…&client_id=…&code=…`). SameSite=Lax cookies are sent on the
 * top-level GET navigation back from the provider, and the value is the same
 * HMAC-signed state the OAuth manager already validates.
 */
export const posOAuthStateCookie = createCookie('pos-oauth-state', {
	maxAge: 60 * 10,
	sameSite: 'lax',
	path: '/',
	httpOnly: true,
	secure: process.env.NODE_ENV === 'production',
})

export async function readPosOAuthState(
	request: Request,
): Promise<string | null> {
	const value = await posOAuthStateCookie.parse(request.headers.get('Cookie'))
	return typeof value === 'string' && value ? value : null
}

export function serializePosOAuthState(state: string): Promise<string> {
	return posOAuthStateCookie.serialize(state)
}

export function clearPosOAuthState(): Promise<string> {
	return posOAuthStateCookie.serialize('', { maxAge: 0 })
}

/**
 * Marks that we have already re-sent a merchant through the provider's
 * authorization endpoint after a code-less launch callback, so we do not loop
 * if the provider keeps returning a launch callback.
 */
export const posOAuthAttemptCookie = createCookie('pos-oauth-launched', {
	maxAge: 60 * 5,
	sameSite: 'lax',
	path: '/',
	httpOnly: true,
	secure: process.env.NODE_ENV === 'production',
})

export async function hasPosOAuthAttempt(request: Request): Promise<boolean> {
	return (
		(await posOAuthAttemptCookie.parse(request.headers.get('Cookie'))) === '1'
	)
}

export function markPosOAuthAttempt(): Promise<string> {
	return posOAuthAttemptCookie.serialize('1')
}

export function clearPosOAuthAttempt(): Promise<string> {
	return posOAuthAttemptCookie.serialize('', { maxAge: 0 })
}
