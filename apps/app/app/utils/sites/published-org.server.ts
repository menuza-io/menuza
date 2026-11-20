import { and, db, eq, Organization } from '@repo/database'
import { getClientIp } from '@repo/security'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { siteHostCondition } from '#app/utils/sites/site-host.server.ts'

/**
 * Shared front of the public `/resources/sites/*` read endpoints added for
 * SEO (#137, #184): `?slug=` or `?host=`, the per-IP rate limit, and the
 * published, active organization (404 otherwise). Selected columns only.
 */
export async function requirePublishedSiteOrganization(request: Request) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	if (!slug && !host) throw new Response('Not Found', { status: 404 })

	const rateLimit = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimit.allowed) throw createRateLimitResponse(rateLimit.resetAt)

	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			dataRegion: Organization.dataRegion,
			customDomain: Organization.customDomain,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
			cuisines: Organization.cuisines,
			priceRange: Organization.priceRange,
		})
		.from(Organization)
		.where(
			and(
				slug ? eq(Organization.slug, slug) : and(siteHostCondition(host!)),
				eq(Organization.active, true),
				eq(Organization.sitePublished, true),
			),
		)
		.limit(1)
	if (!organization) throw new Response('Not Found', { status: 404 })
	return { organization, url }
}
