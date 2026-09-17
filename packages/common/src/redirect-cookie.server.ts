import * as cookie from 'cookie'

import { operatorSharedCookieDomain } from './cookie-domain.server.js'

const key = 'redirectTo'

function redirectCookieOptions(request?: Request) {
	const domain = request ? operatorSharedCookieDomain(request) : undefined
	return {
		path: '/',
		sameSite: 'lax' as const,
		...(domain ? { domain } : {}),
	}
}

export function destroyRedirectToHeader(request?: Request) {
	return cookie.serialize(key, '', {
		maxAge: -1,
		...redirectCookieOptions(request),
	})
}

export function destroyRedirectToHeaders(request?: Request) {
	return { 'set-cookie': destroyRedirectToHeader(request) } as const
}

export function getRedirectCookieHeader(
	redirectTo?: string,
	request?: Request,
) {
	return redirectTo && redirectTo !== '/'
		? cookie.serialize(key, redirectTo, {
				maxAge: 60 * 10,
				...redirectCookieOptions(request),
			})
		: null
}

export function getRedirectCookieValue(request: Request) {
	const rawCookie = request.headers.get('cookie')
	const parsedCookies = rawCookie ? cookie.parse(rawCookie) : {}
	const redirectTo = parsedCookies[key]
	return redirectTo || null
}
