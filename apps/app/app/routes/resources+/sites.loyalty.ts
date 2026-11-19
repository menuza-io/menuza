import { and, db, eq, inArray, Organization } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import { isLoyaltyFeatureEnabled } from '#app/utils/loyalty/access.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

/**
 * Gate for public Loyalty / Rewards website sections on Sites:
 * `GET /resources/sites/loyalty?slug=acme` (or `?host=acme.example.com`).
 *
 * Control-plane flag-only gate: returns `{ enabled: true }` when the website is
 * published and `loyalty.enabled` is turned on; otherwise answers 404.
 * Zero guest PII or member data ever crosses this route.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase()
	const host = url.searchParams.get('host')?.trim().toLowerCase().split(':')[0]
	if (!slug && !host) throw new Response('Not Found', { status: 404 })

	const rateLimit = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimit.allowed) return createRateLimitResponse(rateLimit.resetAt)

	const org = await db.query.Organization.findFirst({
		where: and(
			slug
				? eq(Organization.slug, slug)
				: and(
						eq(Organization.customDomain, host!),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
		),
		columns: { id: true },
	})
	if (!org) throw new Response('Not Found', { status: 404 })

	const enabled = await isLoyaltyFeatureEnabled(org.id)
	if (!enabled) {
		throw new Response('Not Found', { status: 404 })
	}

	return Response.json(
		{ enabled: true },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
