import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
	SHOP_CHECKOUT_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	createPublicShopCheckoutSession,
	findPublishedShopOrganization,
} from '#app/utils/shop.server.ts'

const checkoutSchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
	customerId: z.string().optional(),
	customerEmail: z.string().email().optional().or(z.literal('')),
	embed: z.boolean().optional(),
})

/**
 * Creates a shop checkout session for a tenant site purchase.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
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
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
	}

	const parsed = checkoutSchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	if (!parsed.data.slug && !parsed.data.host) {
		return Response.json({ error: 'slug or host is required' }, { status: 400 })
	}
	// The creator rejects a caller-supplied email. Refuse it before the shop
	// ceiling so that request cannot lock out other customers.
	if (parsed.data.customerEmail) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}

	const organization = await findPublishedShopOrganization({
		slug: parsed.data.slug,
		host: parsed.data.host,
	})
	if (!organization) {
		return new Response('Organization not found', { status: 404 })
	}
	const shopLimit = await checkRateLimit(
		{ type: 'org', value: organization.id },
		SHOP_CHECKOUT_RATE_LIMIT,
	)
	if (!shopLimit.allowed) {
		return createRateLimitResponse(shopLimit.resetAt)
	}

	try {
		const { session, processor } = await createPublicShopCheckoutSession({
			request,
			slug: parsed.data.slug,
			host: parsed.data.host,
			organizationId: organization.id,
			customerId: parsed.data.customerId,
			embed: parsed.data.embed,
		})

		if (!session.url) {
			return Response.json(
				{ error: 'Unable to create checkout session' },
				{ status: 500 },
			)
		}

		return Response.json({
			checkoutUrl: session.url,
			sessionId: session.id,
			processor,
		})
	} catch (error) {
		if (error instanceof Response) throw error
		console.error('Shop checkout error:', error)
		return Response.json({ error: 'Checkout failed' }, { status: 500 })
	}
}
