/**
 * Browser → App hosted checkout for restaurant orders.
 *
 * `POST /resources/sites/order/checkout` with a strict body:
 * `{ slug?: string; host?: string; orderId: string; paymentToken: string; locale?: string }`.
 * Unknown properties — including any customer contact or arbitrary
 * success/cancel URLs — are rejected. The response is
 * `{ checkoutUrl, sessionId, processor }`.
 *
 * App is a payment orchestrator here, not an order store: amounts come from the
 * org's regional tenant service (authoritative), and the receipt capability
 * stays in browser sessionStorage. See docs/restaurant-ordering-contract.md.
 */

import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkRateLimit,
	createRateLimitResponse,
	RESTAURANT_ORDER_CHECKOUT_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { createRestaurantOrderHostedCheckout } from '#app/utils/restaurant-orders/checkout.server.ts'

// Strict: no extra fields, no PII, no client-supplied URLs.
const checkoutSchema = z
	.object({
		slug: z.string().optional(),
		host: z.string().optional(),
		orderId: z.string().min(1),
		paymentToken: z.string().min(1),
		locale: z.string().optional(),
	})
	.strict()

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return Response.json({ error: 'method_not_allowed' }, { status: 405 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		RESTAURANT_ORDER_CHECKOUT_RATE_LIMIT,
	)
	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}

	const parsed = checkoutSchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	const { slug, host, orderId, paymentToken, locale } = parsed.data
	if (!slug && !host) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	try {
		const result = await createRestaurantOrderHostedCheckout({
			slug,
			host,
			orderId,
			paymentToken,
			locale: locale ?? null,
		})
		return Response.json(
			{
				checkoutUrl: result.checkoutUrl,
				sessionId: result.sessionId,
				processor: result.processor,
			},
			{ headers: { 'Cache-Control': 'no-store' } },
		)
	} catch (error) {
		if (error instanceof Response) throw error
		console.error('Restaurant order checkout failed:', error)
		return Response.json(
			{ error: 'checkout_unavailable', retryable: true },
			{ status: 503 },
		)
	}
}
