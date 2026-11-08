import {
	setCookieConsentState,
	verifyCookieConsentRequestOrigin,
} from '@repo/common/cookie-consent'
import { marketingSharedCookieDomain } from '@repo/common/cookie-domain'
import { type APIRoute } from 'astro'
import { getWebEnv } from '../../lib/runtime-env'
import { getSafeReturnLocation } from '../../lib/safe-return-location'

export const prerender = false

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
