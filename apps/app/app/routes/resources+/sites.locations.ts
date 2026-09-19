import { and, db, eq, OrganizationLocation } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'

import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { findPublishedSiteOrganization } from '#app/utils/sites/public-org.server.ts'

/**
 * Public endpoint: active restaurant branches for storefront branch picker.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null

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

	const locations = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			slug: OrganizationLocation.slug,
			city: OrganizationLocation.city,
			state: OrganizationLocation.state,
			isDefault: OrganizationLocation.isDefault,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.active, true),
			),
		)

	return Response.json(
		{ locations },
		{
			headers: {
				'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			},
		},
	)
}
