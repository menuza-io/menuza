import { getUserId } from '@repo/auth'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	UserOrganization,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import { buildPublicSiteDropPayload } from '#app/utils/menu/public-drop-context.server.ts'
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

export type { PublicSiteDropPayload } from '#app/utils/menu/public-drop-context.server.ts'

/**
 * Public endpoint for one published drop (or a member-only preview of a
 * draft). The payload itself is built by `buildPublicSiteDropPayload` (fresh
 * database reads); this route only resolves the org, enforces rate limits,
 * applies member-only preview auth, and serves the KV-cached copy for
 * anonymous traffic.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const ip = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: ip },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	const url = new URL(request.url)
	const orgSlug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const customHost =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const dropSlug = url.searchParams.get('drop')?.trim().toLowerCase() || null

	if (!dropSlug || (!orgSlug && !customHost)) {
		return Response.json(
			{ error: 'Missing required parameters' },
			{ status: 400 },
		)
	}

	// 1. Resolve organization
	const org = await db.query.Organization.findFirst({
		where: and(
			orgSlug
				? eq(Organization.slug, orgSlug)
				: and(
						eq(Organization.customDomain, customHost!),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
		),
		columns: {
			id: true,
			name: true,
			slug: true,
			dataRegion: true,
		},
	})

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	// Preview protection: only authenticated organization members can preview draft drops or bypass KV cache
	const wantsPreview = url.searchParams.get('preview') === 'true'
	let isPreview = false
	if (wantsPreview) {
		const authUserId = await getUserId(request).catch(() => null)
		if (authUserId) {
			const member = await db.query.UserOrganization.findFirst({
				where: and(
					eq(UserOrganization.organizationId, org.id),
					and(
						eq(UserOrganization.userId, authUserId),
						eq(UserOrganization.active, true),
					),
				),
				columns: { userId: true },
			})
			isPreview = Boolean(member)
		}
	}

	const cacheKey = getSiteKvKey('page', org.id, `drop-${dropSlug}`)

	if (!isPreview) {
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					'Cache-Control': 'public, max-age=15, stale-while-revalidate=60',
				},
			})
		}
	}

	// 2. Build the fresh public drop payload (authoritative database reads).
	const payload = await buildPublicSiteDropPayload(
		{
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency: org.dataRegion === 'ksa' ? 'SAR' : 'USD',
		},
		dropSlug,
	)

	if (!payload) {
		return Response.json({ error: 'Drop not found' }, { status: 404 })
	}

	if (payload.drop.status === 'draft' && !isPreview) {
		return Response.json({ error: 'Drop not published' }, { status: 404 })
	}

	if (!isPreview) {
		await setCachedSiteData(cacheKey, payload, 30)
	}

	return Response.json(payload, {
		headers: {
			'Cache-Control': isPreview
				? 'no-cache, no-store'
				: 'public, max-age=15, stale-while-revalidate=60',
		},
	})
}
