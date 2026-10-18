import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	chargeReservationFee,
	logReservationPaymentFailure,
	ReservationPaymentError,
} from '#app/utils/reservations/payments.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const bodySchema = z
	.object({
		reservationId: z.string().trim().min(1).max(128),
		feeId: z.string().trim().min(1).max(128),
	})
	.strict()

/**
 * `POST /resources/reservations/payments/fee?orgSlug=<slug>`
 * `{ reservationId, feeId }`: the host stand's "Charge fee". The region has
 * already created the `fee_pending` row for this operator; the App claims it
 * (single shot), charges the saved card off-session and reports the result,
 * instead of waiting for a tick. Fees are never charged automatically.
 *
 * Requires an operator session with the `payments` feature and
 * `update:reservation_payment:any`; impersonated sessions are refused.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const orgSlug = new URL(request.url).searchParams.get('orgSlug') ?? undefined
	const access = await requireReservationsAccess(request, orgSlug, {
		feature: 'payments',
		anyOf: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT],
	})
	if (await isImpersonating(request)) {
		return Response.json(
			{ error: 'impersonation_forbidden' },
			{ status: 403, headers: NO_STORE },
		)
	}

	const raw = await request.json().catch(() => null)
	const parsed = bodySchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}

	try {
		const result = await chargeReservationFee({
			orgId: access.organizationId,
			reservationId: parsed.data.reservationId,
			feeId: parsed.data.feeId,
		})
		return Response.json(result, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof ReservationPaymentError) {
			return Response.json(
				{ error: error.code, retryable: error.retryable },
				{ status: error.httpStatus, headers: NO_STORE },
			)
		}
		logReservationPaymentFailure('operator fee charge', error)
		return Response.json(
			{ error: 'fee_charge_unavailable', retryable: true },
			{ status: 503, headers: NO_STORE },
		)
	}
}
