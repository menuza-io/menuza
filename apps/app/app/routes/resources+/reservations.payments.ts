import { reservationPaymentCommandSchema } from '@repo/reservations'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	executeReservationPaymentCommand,
	logReservationPaymentFailure,
	ReservationPaymentError,
} from '#app/utils/reservations/payments.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/reservations/payments`: where the regional outbox delivers
 * payment commands (`refund_request`, `checkout_expire`). The body is a strict
 * command of opaque ids; a rejected value is never echoed.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. Idempotent: the region's
 * single-shot claim and the deterministic provider keys make a replay safe.
 * Answers 200 on success (including an already-handled command), 503
 * `{ retryable: true }` on a transient failure so the outbox retries, and 4xx
 * on an invalid command.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: a plain 401 instead of the browser redirect.
		if (error instanceof Response && error.status === 302) {
			return new Response('Unauthorized', { status: 401 })
		}
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = reservationPaymentCommandSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request', retryable: false },
			{ status: 400, headers: NO_STORE },
		)
	}

	try {
		const result = await executeReservationPaymentCommand(parsed.data)
		return Response.json({ ok: true, ...result }, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof ReservationPaymentError) {
			return Response.json(
				{ error: error.code, retryable: error.retryable },
				{ status: error.httpStatus, headers: NO_STORE },
			)
		}
		logReservationPaymentFailure('payment command', error)
		return Response.json(
			{ error: 'payment_command_unavailable', retryable: true },
			{ status: 503, headers: NO_STORE },
		)
	}
}
