import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import { getDefaultOrganizationLocationId } from '#app/utils/organization/locations.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { findPublishedSiteOrganization } from '#app/utils/sites/public-org.server.ts'

/**
 * Default restaurant location for published tenant sites.
 * Query: ?slug=acme OR ?host=www.acme.com
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')
	const host = url.searchParams.get('host')

	if (!slug && !host) {
		throw new Response('Not Found', { status: 404 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		PUBLIC_SITE_RATE_LIMIT,
	)

	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	const organization = await findPublishedSiteOrganization({ slug, host })
	if (!organization) {
		throw new Response('Not Found', { status: 404 })
	}

	const locationId = await getDefaultOrganizationLocationId(organization.id)

	return Response.json(
		{
			locationId,
		},
		{
			headers: {
				'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			},
		},
	)
}
