import { db, and, eq, inArray, Organization } from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	buildPublicSiteMenuPayload,
	type PublicSiteMenuOrgContext,
} from '#app/utils/menu/public-menu-context.server.ts'
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

export type {
	PublicLocationData,
	PublicMenuCategoryData,
	PublicMenuItemData,
	PublicMenuOptionData,
	PublicModifierGroupData,
} from '#app/utils/menu/public-serializers.server.ts'

export type { PublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'

/**
 * Public endpoint for fetching an organization's restaurant menus, active locations,
 * categories, items, modifiers, and options with edge KV caching.
 *
 * The payload itself is built by `buildPublicSiteMenuPayload` (fresh database
 * reads); this route only resolves the org, enforces rate limits, applies
 * member-only preview semantics, and serves the KV-cached copy for anonymous
 * traffic.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const locationId = url.searchParams.get('locationId') || null
	// Accept both `preview=1` (sent by apps/sites) and `preview=true`.
	const previewParam = url.searchParams.get('preview')
	const wantsPreview = previewParam === '1' || previewParam === 'true'

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

	// 1. Resolve organization
	type OrgSelect = {
		id: string
		name: string
		slug: string
		siteDefaultLocale: string | null
		siteLocales: string | null
		customDomain: string | null
		currency: string
	}
	let org: OrgSelect | undefined
	if (slug) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
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
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	} else if (host) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
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
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	}

	if (!org) {
		throw new Response('Not Found', { status: 404 })
	}

	// `preview` bypasses the edge KV cache, which forces an uncached full menu
	// scan. Only honour it when the request presents the organization's own
	// custom domain via the `host` signal this route already trusts to resolve a
	// custom-domain org, so an anonymous `?preview=1` cannot trigger it.
	const isPreview =
		wantsPreview && Boolean(host) && org.customDomain?.toLowerCase() === host

	const orgId = org.id
	const queryHash = locationId || 'all'
	const cacheKey = getSiteKvKey('page', orgId, `menu-${queryHash}`)

	// Check KV Cache
	if (!isPreview) {
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Accept-Language',
				},
			})
		}
	}

	// 2. Build the fresh public menu payload (authoritative database reads).
	const orgContext: PublicSiteMenuOrgContext = {
		id: org.id,
		name: org.name,
		slug: org.slug,
		currency: org.currency,
		siteDefaultLocale: org.siteDefaultLocale,
		siteLocales: org.siteLocales,
		customDomain: org.customDomain,
	}
	const { payload, secondsUntilVariationReturn } =
		await buildPublicSiteMenuPayload(orgContext, locationId)

	if (
		!isPreview &&
		(secondsUntilVariationReturn === null || secondsUntilVariationReturn >= 60)
	) {
		await setCachedSiteData(
			cacheKey,
			payload,
			secondsUntilVariationReturn ?? undefined,
		)
	}

	const cacheControl =
		secondsUntilVariationReturn !== null && secondsUntilVariationReturn < 60
			? `public, max-age=${Math.max(1, secondsUntilVariationReturn)}`
			: 'public, max-age=60, stale-while-revalidate=300'

	return Response.json(payload, {
		headers: {
			'Cache-Control': cacheControl,
			Vary: 'Accept-Language',
		},
	})
}
