import { and, db, eq, inArray, Organization } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'

/**
 * Gate for the guest reservation pages on Sites:
 * `GET /resources/sites/reservations?slug=acme` (or `?host=acme.example.com`).
 *
 * Public, flag-only data: which parts of the booking flow the restaurant has
 * switched on. It answers 404 until the website is published and both
 * `reservations.enabled` and `reservations.online` are on (checked on every
 * request), so a module that is off looks like it does not exist and Sites
 * falls back to a CMS page named `reserve` or its own 404. Manage links keep
 * working because they talk to tenant-api directly, not through this gate.
 *
 * `notifyMe` follows the waitlist flag; the per-location setting is part of
 * the regional availability response, which the App never reads.
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

	const state = await getReservationsFeatureState(org.id)
	if (!state.enabled || !state.online) {
		throw new Response('Not Found', { status: 404 })
	}

	return Response.json(
		{
			online: state.online,
			waitlist: state.waitlist,
			experiences: state.experiences,
			notifyMe: state.waitlist,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
