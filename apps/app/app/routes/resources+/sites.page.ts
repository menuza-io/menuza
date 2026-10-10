import { and, db, eq, inArray, Organization } from '@repo/database'
import { getClientLocales } from '@repo/i18n/server'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	getCachedSiteData,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'
import { verifySitePreviewToken } from '#app/utils/sites/preview-token.server.ts'
import {
	findPublishedSitePage,
	toPublicPagePayload,
} from '#app/utils/sites/public-org.server.ts'

/**
 * Public endpoint for fetching an org Site's page.
 * Returns the page and its sections.
 *
 * Query: ?slug=acme&page=about  OR  ?host=www.acme.com&page=about
 * Landing page: ?slug=acme&home=true
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const pageSlug = url.searchParams.get('page')
	const wantHome = url.searchParams.get('home') === 'true'
	const lng = url.searchParams.get('lng')

	if ((!slug && !host) || (!pageSlug && !wantHome)) {
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

	const wantsPreview = url.searchParams.get('preview') === 'true'
	const previewToken = url.searchParams.get('pt')
	const acceptLocales = getClientLocales(request)

	// We will generate the cache key after getting orgId

	// First find the organization to ensure it's published and active, and to get its ID
	let orgId = null
	let defaultLocale = 'en'
	let headerConfig: string | null = null
	let footerConfig: string | null = null
	if (slug) {
		const [org] = await db
			.select({
				id: Organization.id,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteHeaderConfig: Organization.siteHeaderConfig,
				siteFooterConfig: Organization.siteFooterConfig,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.slug, slug),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
				),
			)
			.limit(1)
		orgId = org?.id
		defaultLocale = org?.siteDefaultLocale ?? 'en'
		headerConfig = org?.siteHeaderConfig ?? null
		footerConfig = org?.siteFooterConfig ?? null
	} else if (host) {
		const [org] = await db
			.select({
				id: Organization.id,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteHeaderConfig: Organization.siteHeaderConfig,
				siteFooterConfig: Organization.siteFooterConfig,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.customDomain, host),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
					inArray(Organization.customDomainStatus, ['active', 'pending']),
				),
			)
			.limit(1)
		orgId = org?.id
		defaultLocale = org?.siteDefaultLocale ?? 'en'
		headerConfig = org?.siteHeaderConfig ?? null
		footerConfig = org?.siteFooterConfig ?? null
	}

	if (!orgId) {
		throw new Response('Not Found', { status: 404 })
	}

	// Drafts are only served to editors holding a signed, org-bound token.
	const isPreview = wantsPreview && verifySitePreviewToken(orgId, previewToken)

	const localeKey = Array.isArray(acceptLocales)
		? acceptLocales.join(',')
		: (acceptLocales ?? '')
	const queryHash = `${pageSlug || ''}-${wantHome}-${lng || ''}-${localeKey}`
	let cacheKey: string | null = null

	if (!isPreview) {
		cacheKey = getSiteKvKey('page', orgId, queryHash)
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					// Draft content must never sit in a shared cache, even keyed by token.
					'Cache-Control': isPreview
						? 'private, no-store'
						: 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Accept-Language',
				},
			})
		}
	}

	// Then fetch the page
	const page = await findPublishedSitePage(orgId, pageSlug, {
		preview: isPreview,
		home: wantHome,
	})

	if (!page) {
		throw new Response('Not Found', { status: 404 })
	}

	const preferredLocales = lng
		? [
				lng,
				...(Array.isArray(acceptLocales)
					? acceptLocales
					: acceptLocales
						? [acceptLocales]
						: []),
			]
		: acceptLocales

	// The `toPublicPagePayload` helper will use the first preferred locale
	const requestedLocale = Array.isArray(preferredLocales)
		? preferredLocales[0]
		: typeof preferredLocales === 'string'
			? preferredLocales
			: defaultLocale

	const payload = toPublicPagePayload(page, requestedLocale, defaultLocale, {
		headerConfig,
		footerConfig,
	})

	if (!isPreview && cacheKey) {
		await setCachedSiteData(cacheKey, payload)
	}

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			Vary: 'Accept-Language',
		},
	})
}
