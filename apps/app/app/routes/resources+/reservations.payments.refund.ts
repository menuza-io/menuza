import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	executeReservationRefundRequest,
	logReservationPaymentFailure,
	ReservationPaymentError,
} from '#app/utils/reservations/payments.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const bodySchema = z
	.object({ refundRequestId: z.string().trim().min(1).max(128) })
	.strict()

/**
 * `POST /resources/reservations/payments/refund?orgSlug=<slug>`
 * `{ refundRequestId }`: run a refund the region already decided and recorded
 * (cancellation terms or an operator's partial refund) now, instead of at the
 * next tick. The App claims it, refunds at the provider (reversing the
 * transfer and the platform fee) and reports the result.
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
		const result = await executeReservationRefundRequest({
			orgId: access.organizationId,
			refundRequestId: parsed.data.refundRequestId,
		})
		return Response.json(result, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof ReservationPaymentError) {
			return Response.json(
				{ error: error.code, retryable: error.retryable },
				{ status: error.httpStatus, headers: NO_STORE },
			)
		}
		logReservationPaymentFailure('operator refund', error)
		return Response.json(
			{ error: 'refund_unavailable', retryable: true },
			{ status: 503, headers: NO_STORE },
		)
	}
}
