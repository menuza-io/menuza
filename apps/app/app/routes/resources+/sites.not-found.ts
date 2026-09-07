import {
	and,
	db,
	eq,
	inArray,
	Organization,
	sql,
	WebsiteNotFoundLog,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

const NotFoundPayloadSchema = z.object({
	slug: z.string().trim().toLowerCase().optional(),
	host: z.string().trim().toLowerCase().optional(),
	path: z.string().trim().min(1).max(2048),
	referrer: z.string().trim().max(2048).optional().nullable(),
	userAgent: z.string().trim().max(1024).optional().nullable(),
})

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		PUBLIC_SITE_RATE_LIMIT,
	)

	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 })
	}

	const parseResult = NotFoundPayloadSchema.safeParse(body)
	if (!parseResult.success) {
		return Response.json({ error: 'Invalid payload' }, { status: 400 })
	}

	const { slug, host, path, referrer, userAgent } = parseResult.data
	if (!slug && !host) {
		return Response.json({ error: 'Slug or host is required' }, { status: 400 })
	}

	const normalizedHost = host ? host.split(':')[0] : null

	// Find the organization
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(
			slug
				? and(
						eq(Organization.slug, slug),
						eq(Organization.active, true),
						eq(Organization.sitePublished, true),
					)
				: and(
						eq(Organization.customDomain, normalizedHost!),
						eq(Organization.active, true),
						eq(Organization.sitePublished, true),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
		)
		.limit(1)

	if (!organization) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	// Normalize path (ensure leading slash, strip trailing slash unless root)
	let normalizedPath = path.startsWith('/') ? path : `/${path}`
	if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	const now = new Date()

	// Atomic upsert: increment hitCount and update metadata on conflict
	await db
		.insert(WebsiteNotFoundLog)
		.values({
			organizationId: organization.id,
			path: normalizedPath,
			hitCount: 1,
			firstHitAt: now,
			lastHitAt: now,
			lastReferrer: referrer ?? null,
			lastUserAgent: userAgent ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [WebsiteNotFoundLog.organizationId, WebsiteNotFoundLog.path],
			set: {
				hitCount: sql`${WebsiteNotFoundLog.hitCount} + 1`,
				lastHitAt: now,
				...(referrer ? { lastReferrer: referrer } : {}),
				...(userAgent ? { lastUserAgent: userAgent } : {}),
				updatedAt: now,
			},
		})

	return Response.json({ ok: true })
}
