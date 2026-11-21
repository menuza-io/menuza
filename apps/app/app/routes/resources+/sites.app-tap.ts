import { tapSchema } from '@repo/common/customer-app'
import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	loadLiveStores,
	recordTap,
} from '#app/utils/customer-apps/service.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { findPublishedSiteOrganization } from '#app/utils/sites/public-org.server.ts'

const BodySchema = tapSchema.extend({
	slug: z.string().trim().toLowerCase().min(1).max(100).optional(),
	host: z.string().trim().toLowerCase().min(1).max(253).optional(),
})

/**
 * A tap on a "Get the app" placement (#196), counted per app, placement, store
 * and day. Called by the public site when it redirects a visitor to a store
 * (`POST /resources/sites/app-tap`). It carries no visitor id, address or
 * user agent, counts only stores that are live and placements the owner has
 * on, and is rate limited per address like the other public site writes.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const rate = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rate.allowed) return createRateLimitResponse(rate.resetAt)
	const parsed = BodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success || (!parsed.data.slug && !parsed.data.host)) {
		return Response.json({ error: 'Invalid payload' }, { status: 400 })
	}
	const organization = await findPublishedSiteOrganization({
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if (!organization)
		return Response.json({ error: 'Not Found' }, { status: 404 })
	const result = await loadLiveStores(organization.id)
	// Nothing to count for a store that is not live.
	if (!result || !result.live[parsed.data.store]) {
		return Response.json({ ok: true, counted: false })
	}
	await recordTap({
		appId: result.app.id,
		placement: parsed.data.placement,
		store: parsed.data.store,
	})
	return Response.json({ ok: true, counted: true })
}
