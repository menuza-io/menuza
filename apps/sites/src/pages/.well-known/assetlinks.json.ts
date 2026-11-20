import { type APIRoute } from 'astro'
import { assetLinksFor, associationResponse } from '~/lib/app-links'

export const prerender = false

/** `/.well-known/assetlinks.json` for this site's own branded Android app (#195). */
export const GET: APIRoute = ({ locals }) =>
	associationResponse(
		locals.requestedLocale === locals.defaultLocale
			? assetLinksFor(locals.organization?.customerApp)
			: null,
	)
