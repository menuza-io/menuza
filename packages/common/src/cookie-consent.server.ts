import { createCookie } from 'react-router'

import {
	operatorCookieName,
	sharedCookieDomain,
} from './cookie-domain.server.js'

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

type CookieConsentCookie = ReturnType<typeof createCookieConsentCookie>

/** App/Admin default cookie — lazy so web can import helpers without `BASE_URL`. */
let defaultCookieConsentCookie: CookieConsentCookie | undefined

function getDefaultCookieConsentCookie() {
	defaultCookieConsentCookie ??= createCookieConsentCookie()
	return defaultCookieConsentCookie
}

/** Default App/Admin cookie, retained for existing callers and test fixtures. */
export const cookieConsentCookie: CookieConsentCookie = {
	get name() {
		return getDefaultCookieConsentCookie().name
	},
	isSigned: true,
	parse(cookieHeader) {
		return getDefaultCookieConsentCookie().parse(cookieHeader)
	},
	serialize(value) {
		return getDefaultCookieConsentCookie().serialize(value)
	},
}

export async function getCookieConsentState(request: Request, origin?: string) {
	const cookieHeader = request.headers.get('Cookie')
	const consentCookie = origin
		? createCookieConsentCookie(origin)
		: getDefaultCookieConsentCookie()
	const cookie = (await consentCookie.parse(cookieHeader)) || {}
	return cookie.hasConsented
}

export async function setCookieConsentState(
	hasConsented: boolean,
	origin?: string,
	domain?: string,
) {
	const consentCookie =
		origin || domain
			? createCookieConsentCookie(origin, domain)
			: getDefaultCookieConsentCookie()
	return await consentCookie.serialize({ hasConsented })
}

/** Reject cross-site POSTs; SameSite=Lax is the primary defense. */
export function verifyCookieConsentRequestOrigin(request: Request) {
	const requestOrigin = new URL(request.url).origin
	const origin = request.headers.get('Origin')
	if (origin) {
		try {
			return new URL(origin).origin === requestOrigin
		} catch {
			return false
		}
	}
	const referer = request.headers.get('Referer')
	if (referer) {
		try {
			return new URL(referer).origin === requestOrigin
		} catch {
			return false
		}
	}
	return false
}
