import { createCookie } from 'react-router'

import {
	operatorCookieName,
	sharedCookieDomain,
} from './cookie-domain.server.ts'

const cookieConsentOptions = (origin?: string, domain?: string) => ({
	maxAge: 31_536_000, // one year
	sameSite: 'lax' as const,
	path: '/',
	httpOnly: true,
	domain: domain ?? sharedCookieDomain(origin),
})

function createCookieConsentCookie(origin?: string, domain?: string) {
	return createCookie(
		operatorCookieName('cconsent', origin),
		cookieConsentOptions(origin, domain),
	)
}

/** Default App/Admin cookie, retained for existing callers and test fixtures. */
export const cookieConsentCookie = createCookieConsentCookie()

export async function getCookieConsentState(request: Request, origin?: string) {
	const cookieHeader = request.headers.get('Cookie')
	const consentCookie = origin
		? createCookieConsentCookie(origin)
		: cookieConsentCookie
	const cookie = (await consentCookie.parse(cookieHeader)) || {}
	return cookie.isCollapsed
}

export async function setCookieConsentState(
	isCollapsed: boolean,
	origin?: string,
	domain?: string,
) {
	const consentCookie =
		origin || domain
			? createCookieConsentCookie(origin, domain)
			: cookieConsentCookie
	return await consentCookie.serialize({ isCollapsed })
}
