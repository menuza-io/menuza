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
	getSiteCacheVersion,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'
import { withPublicCors } from '#app/utils/sites/public-cors.server.ts'
import {
	findPublishedSiteOrganization,
	toPublicSitePayload,
} from '#app/utils/sites/public-org.server.ts'

/**
 * Public endpoint for org Sites pages.
 * Returns only non-sensitive fields for published, active organizations.
 *
 * Query: ?slug=acme  OR  ?host=www.acme.com
 * Optional: ?lng=ar
 */
export const loader = withPublicCors(async function loader({
	request,
}: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const lng = url.searchParams.get('lng')

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

	const acceptLocales = getClientLocales(request)
	const preferredLocale = lng
		? [
				lng,
				...(Array.isArray(acceptLocales)
					? acceptLocales
					: acceptLocales
						? [acceptLocales]
						: []),
			]
		: acceptLocales

	// Cache in KV
	const localeKey = Array.isArray(acceptLocales)
		? acceptLocales.join(',')
		: (acceptLocales ?? '')
	const queryHash = `${slug || ''}-${host || ''}-${lng || ''}-${localeKey}`
	const cacheVersion = await getSiteCacheVersion(organization.id)
	const cacheKey =
		cacheVersion === null
			? null
			: getSiteKvKey('org', organization.id, queryHash, cacheVersion)

	let payload = cacheKey ? await getCachedSiteData(cacheKey) : null
	if (!payload) {
		// Only data read after the cache version may be cached under it, so a
		// publish that lands meanwhile cannot be hidden behind an old copy.
		const fresh = cacheKey
			? await findPublishedSiteOrganization({ slug, host })
			: organization
		if (!fresh || fresh.id !== organization.id) {
			throw new Response('Not Found', { status: 404 })
		}
		payload = toPublicSitePayload(fresh, { preferredLocale })
		if (cacheKey && cacheVersion !== null) {
			await setCachedSiteData(cacheKey, payload, {
				orgId: organization.id,
				version: cacheVersion,
			})
		}
	}

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			Vary: 'Accept-Language',
		},
	})
})
