import { createCookie } from 'react-router'

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
