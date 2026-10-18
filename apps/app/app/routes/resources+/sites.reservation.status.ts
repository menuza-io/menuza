/**
 * Sites server -> App payment status poll for reservation payments.
 *
 * `POST /resources/sites/reservation/status` with the same strict body as the
 * checkout route. The App performs the trusted provider lookup, pushes any
 * terminal state to the org's region and reports the region's view. A redirect
 * alone never marks a payment paid. Authenticated with `INTERNAL_COMMAND_TOKEN`.
 */

import { reservationCheckoutRequestSchema } from '@repo/reservations'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	getReservationPaymentStatus,
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
		const result = await getReservationPaymentStatus({
			...parsed.data,
			locale: parsed.data.locale ?? null,
		})
		return Response.json(result, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof Response) return error
		logReservationPaymentFailure('status', error)
		return Response.json(
			{ error: 'status_unavailable', retryable: true },
			{ status: 503 },
		)
	}
}
