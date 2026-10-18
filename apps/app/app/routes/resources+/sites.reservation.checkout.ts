/**
 * Sites server -> App hosted checkout for reservation payments.
 *
 * `POST /resources/sites/reservation/checkout` with the strict
 * `reservationCheckoutRequestSchema`: `{ slug | host, reservationId | feeId,
 * paymentToken, purpose, locale? }`. Unknown properties (any guest data or a
 * client-supplied URL) are rejected. The response is
 * `{ checkoutUrl, sessionId, processor, purpose, mode }`.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` (the Sites server calls it; the
 * browser never does). Amounts come from the region's quote, never the caller.
 */

import { reservationCheckoutRequestSchema } from '@repo/reservations'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	createReservationHostedCheckout,
	logReservationPaymentFailure,
} from '#app/utils/reservations/payments.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return Response.json({ error: 'method_not_allowed' }, { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return Response.json({ error: 'unauthorized' }, { status: 401 })
		}
		throw error
	}

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}
	const parsed = reservationCheckoutRequestSchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	}

	try {
		const result = await createReservationHostedCheckout({
			...parsed.data,
			locale: parsed.data.locale ?? null,
		})
		return Response.json(result, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof Response) return error
		logReservationPaymentFailure('checkout', error)
		return Response.json(
			{ error: 'checkout_unavailable', retryable: true },
			{ status: 503 },
		)
	}
}
