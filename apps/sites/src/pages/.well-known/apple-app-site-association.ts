import { type APIRoute } from 'astro'
import { appleAssociationFor, associationResponse } from '~/lib/app-links'

export const prerender = false

/**
 * `/.well-known/apple-app-site-association` for this site's own branded app
 * (#195): universal links for the restaurant's order, booking and offer links.
 */
export const GET: APIRoute = ({ locals }) =>
	associationResponse(
		locals.requestedLocale === locals.defaultLocale
			? appleAssociationFor(locals.organization?.customerApp)
			: null,
	)
