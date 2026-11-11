import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	Organization,
	WebsitePage,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

/** Search engines take up to 50,000 URLs per sitemap; a restaurant site has far fewer. */
const MAX_LISTED_PAGES = 500

export type PublicSitePageListing = {
	slug: string
	isHomePage: boolean
	/** In the site's default language. */
	title: string
	description: string | null
	updatedAt: string
}

export type PublicSitePagesPayload = {
	pages: PublicSitePageListing[]
}

/**
 * The published, indexable pages of an organization's site, for Sites'
 * `sitemap.xml` and `llms.txt`: `GET /resources/sites/pages?slug=acme` or
 * `?host=www.acme.com`.
 *
 * Public content only. Drafts and pages marked "hide from search engines" are
 * left out, and it answers 404 until the site is published.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	if (!slug && !host) throw new Response('Not Found', { status: 404 })

	const rateLimit = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimit.allowed) return createRateLimitResponse(rateLimit.resetAt)

	const [org] = await db
		.select({
			id: Organization.id,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(
			and(
				slug
					? eq(Organization.slug, slug)
					: and(
							eq(Organization.customDomain, host!),
							inArray(Organization.customDomainStatus, ['active', 'pending']),
						),
				eq(Organization.active, true),
				eq(Organization.sitePublished, true),
			),
		)
		.limit(1)
	if (!org) throw new Response('Not Found', { status: 404 })

	const { defaultLocale } = parseSiteLocalesConfig(
		org.siteLocales,
		org.siteDefaultLocale,
	)

	const rows = await db
		.select({
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
			title: WebsitePage.title,
			seoTitle: WebsitePage.seoTitle,
			seoDescription: WebsitePage.seoDescription,
			updatedAt: WebsitePage.updatedAt,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.organizationId, org.id),
				eq(WebsitePage.status, 'published'),
				eq(WebsitePage.seoNoIndex, false),
			),
		)
		.orderBy(asc(WebsitePage.position), asc(WebsitePage.createdAt))
		.limit(MAX_LISTED_PAGES)

	const pages: PublicSitePageListing[] = rows.map((row) => {
		const title =
			pickLocalized(row.title, defaultLocale, defaultLocale) || row.title
		const description = row.seoDescription
			? pickLocalized(row.seoDescription, defaultLocale, defaultLocale) || null
			: null
		return {
			slug: row.slug,
			isHomePage: row.isHomePage,
			title:
				(row.seoTitle
					? pickLocalized(row.seoTitle, defaultLocale, defaultLocale)
					: '') || title,
			description,
			updatedAt: row.updatedAt.toISOString(),
		}
	})

	return Response.json({ pages } satisfies PublicSitePagesPayload, {
		headers: { 'Cache-Control': 'public, max-age=300' },
	})
}
