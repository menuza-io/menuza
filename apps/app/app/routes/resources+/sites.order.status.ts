/**
 * Browser → App payment status poll for restaurant orders.
 *
 * `POST /resources/sites/order/status` with a strict body:
 * `{ slug?: string; host?: string; orderId: string; paymentToken: string }`.
 * No PII. App performs the trusted provider lookup for processors that
 * support it, pushes any terminal state to the org's regional tenant service,
 * and reports the resulting payment status. A redirect alone never marks an
 * order paid, and the receipt itself stays regional.
 */

import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkRateLimit,
	createRateLimitResponse,
	RESTAURANT_ORDER_STATUS_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { getRestaurantOrderPaymentStatus } from '#app/utils/restaurant-orders/checkout.server.ts'

// Strict: no extra fields, no PII.
const statusSchema = z
	.object({
		slug: z.string().optional(),
		host: z.string().optional(),
		orderId: z.string().min(1),
		paymentToken: z.string().min(1),
	})
	.strict()

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return Response.json({ error: 'method_not_allowed' }, { status: 405 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		RESTAURANT_ORDER_STATUS_RATE_LIMIT,
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

	const parsed = statusSchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	const { slug, host, orderId, paymentToken } = parsed.data
	if (!slug && !host) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	try {
		const result = await getRestaurantOrderPaymentStatus({
			slug,
			host,
			orderId,
			paymentToken,
		})
		return Response.json(result, {
			headers: { 'Cache-Control': 'no-store' },
		})
	} catch (error) {
		if (error instanceof Response) throw error
		console.error('Restaurant order status lookup failed:', error)
		return Response.json(
			{ error: 'status_unavailable', retryable: true },
			{ status: 503 },
		)
	}
}
