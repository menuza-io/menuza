/**
 * Purges public site KV cache. Authenticated with `INTERNAL_COMMAND_TOKEN`
 * (Admin calls this after a discount flag changes; App has the SITES_DATA_KV
 * binding). Two shapes:
 *
 * - `{ organizationId }`: drops that organization's cached site data (an
 *   organization-level flag changed).
 * - `{ scope: 'all-menus' }`: starts a new menu generation, so every
 *   organization's cached menu is rebuilt (a system-level flag changed; see
 *   `bumpMenuCacheGeneration`).
 *
 * Each is rate limited, so a burst of flag changes (or a leaked token) can't
 * turn into a stream of purges and cold cache rebuilds. The limits sit far
 * above what a person toggling flags in Admin can reach.
 */

import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import {
	bumpMenuCacheGeneration,
	purgeOrganizationSiteCache,
} from '#app/utils/sites/kv-cache.server.ts'

/** The largest body this route reads. Either shape fits in a few dozen bytes. */
export const SITE_CACHE_PURGE_MAX_BODY_BYTES = 1024

export const SITE_CACHE_PURGE_RATE_LIMIT: RateLimitConfig = {
	scope: 'sites-cache-purge',
	maxRequests: 30,
	windowMs: 60 * 1000,
}

export const SITE_MENUS_PURGE_RATE_LIMIT: RateLimitConfig = {
	scope: 'sites-cache-purge-all-menus',
	maxRequests: 10,
	windowMs: 60 * 1000,
}

const bodySchema = z.union([
	z
		.object({ organizationId: z.string().regex(TENANT_ORG_ID_PATTERN) })
		.strict(),
	z.object({ scope: z.literal('all-menus') }).strict(),
])

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
		throw error
	}

	const declared = Number(request.headers.get('Content-Length') ?? 0)
	if (declared > SITE_CACHE_PURGE_MAX_BODY_BYTES) {
		return Response.json({ error: 'Body too large' }, { status: 413 })
	}
	const text = await request.text().catch(() => '')
	// A chunked body carries no length up front, so count what arrived too.
	if (new TextEncoder().encode(text).length > SITE_CACHE_PURGE_MAX_BODY_BYTES) {
		return Response.json({ error: 'Body too large' }, { status: 413 })
	}
	let raw: unknown = null
	try {
		raw = JSON.parse(text)
	} catch {
		raw = null
	}
	const parsed = bodySchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid body' }, { status: 400 })
	}

	if ('scope' in parsed.data) {
		const limited = await rateLimited(
			{ type: 'token', value: 'all-menus' },
			SITE_MENUS_PURGE_RATE_LIMIT,
		)
		if (limited) return limited
		const bumped = await bumpMenuCacheGeneration()
		return Response.json({ ok: bumped })
	}

	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, parsed.data.organizationId),
			eq(Organization.active, true),
		),
		columns: { id: true, slug: true, customDomain: true },
	})
	if (!org) return new Response('Not Found', { status: 404 })

	const limited = await rateLimited(
		{ type: 'org', value: org.id },
		SITE_CACHE_PURGE_RATE_LIMIT,
	)
	if (limited) return limited
	await purgeOrganizationSiteCache(org.id, org.slug, org.customDomain)
	return Response.json({ ok: true })
}

async function rateLimited(
	key: Parameters<typeof checkRateLimit>[0],
	config: RateLimitConfig,
): Promise<Response | null> {
	const { allowed, resetAt } = await checkRateLimit(key, config)
	if (allowed) return null
	const retryAfter = Math.max(
		1,
		Math.ceil((resetAt.getTime() - Date.now()) / 1000),
	)
	return Response.json(
		{ error: 'Too many purges. Try again shortly.' },
		{ status: 429, headers: { 'Retry-After': String(retryAfter) } },
	)
}
