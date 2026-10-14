import { isValidJobPostingSlug } from '@repo/common/job-posting'
import { and, db, eq, inArray, Organization } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	getPublicJobPosting,
	listPublicJobPostings,
} from '#app/utils/hiring/job-postings.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { isStaffingFeatureEnabled } from '#app/utils/staffing/access.server.ts'

/**
 * Public careers data for Sites (and anyone who wants the open roles as JSON):
 * `GET /resources/sites/careers?slug=acme` lists the live postings, and
 * `&posting=line-cook` returns one with its description and questions.
 *
 * Public content only, no person data. It answers 404 until the organization
 * has published its site and turned on `staffing.hiring` (the flag is checked
 * on every request), so a module that is off looks like it does not exist.
 * Which answer to a question is a dealbreaker is never included.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase()
	const host = url.searchParams.get('host')?.trim().toLowerCase().split(':')[0]
	const postingSlug = url.searchParams.get('posting')?.trim().toLowerCase()
	// The language the visitor reads; untranslated text falls back to the default.
	const locale = url.searchParams.get('locale')?.trim() || null
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
		columns: { id: true, name: true, siteDefaultLocale: true },
	})
	if (!org) throw new Response('Not Found', { status: 404 })
	if (!(await isStaffingFeatureEnabled(org.id, 'hiring'))) {
		throw new Response('Not Found', { status: 404 })
	}

	const language = {
		locale,
		defaultLocale: org.siteDefaultLocale || 'en',
	}
	const headers = { 'Cache-Control': 'no-store' }
	if (postingSlug !== undefined && postingSlug !== '') {
		if (!isValidJobPostingSlug(postingSlug)) {
			throw new Response('Not Found', { status: 404 })
		}
		const posting = await getPublicJobPosting(
			org.id,
			postingSlug,
			undefined,
			language,
		)
		if (!posting) throw new Response('Not Found', { status: 404 })
		return Response.json(
			{ organization: { name: org.name }, posting },
			{ headers },
		)
	}

	const postings = await listPublicJobPostings(org.id, undefined, language)
	return Response.json(
		{ organization: { name: org.name }, postings },
		{ headers },
	)
}
