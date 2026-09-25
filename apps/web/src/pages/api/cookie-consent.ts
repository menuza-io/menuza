import {
	setCookieConsentState,
	verifyCookieConsentRequestOrigin,
} from '@repo/common/cookie-consent'
import { marketingSharedCookieDomain } from '@repo/common/cookie-domain'
import { type APIRoute } from 'astro'
import { getWebEnv } from '../../lib/runtime-env'

export const prerender = false

function getSafeReturnLocation(request: Request): string {
	const fallback = '/'
	const referer = request.headers.get('Referer')
	if (!referer) return fallback

	try {
		const requestUrl = new URL(request.url)
		const refererUrl = new URL(referer)
		if (requestUrl.origin !== refererUrl.origin) return fallback
		return `${refererUrl.pathname}${refererUrl.search}${refererUrl.hash}`
	} catch {
		return fallback
	}
}

export const POST: APIRoute = async ({ request }) => {
	if (!verifyCookieConsentRequestOrigin(request)) {
		return new Response('Invalid origin', { status: 403 })
	}

	const formData = await request.formData()
	const preference = formData.get('consent')

	if (preference !== 'true' && preference !== 'false') {
		return new Response('Invalid cookie consent preference', { status: 400 })
	}

	const cookie = await setCookieConsentState(
		preference === 'true',
		getWebEnv('PUBLIC_APP_URL'),
		marketingSharedCookieDomain(request, getWebEnv('PUBLIC_ROOT_APP')),
	)

	return new Response(null, {
		status: 303,
		headers: {
			Location: getSafeReturnLocation(request),
			'Set-Cookie': cookie,
		},
	})
}
