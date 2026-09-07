import { setCookieConsentState } from '@repo/common/cookie-consent'
import { type APIRoute } from 'astro'
import { ENV } from 'varlock/env'

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
	const formData = await request.formData()
	const preference = formData.get('consent')

	if (preference !== 'true' && preference !== 'false') {
		return new Response('Invalid cookie consent preference', { status: 400 })
	}

	const rootDomain = ENV.PUBLIC_ROOT_APP?.trim().replace(/^\.+/, '')
	const cookie = await setCookieConsentState(
		preference === 'true',
		ENV.PUBLIC_APP_URL,
		rootDomain ? `.${rootDomain}` : undefined,
	)

	return new Response(null, {
		status: 303,
		headers: {
			Location: getSafeReturnLocation(request),
			'Set-Cookie': cookie,
		},
	})
}
