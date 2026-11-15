import { orderRefundExecuteRequestSchema } from '@repo/common/restaurant-orders'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	executeRestaurantOrderRefund,
	logRestaurantRefundFailure,
	RestaurantOrderRefundError,
} from '#app/utils/restaurant-orders/refunds.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/orders/refund-execute` `{ orgId, refundId }`: the region's
 * kick after it booked a provider refund itself (a cancel with a refund,
 * Station Orders, guest self-cancel, an order not accepted in time).
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only (constant-time compare);
 * the body is ids only (strict `orderRefundExecuteRequestSchema`). The App
 * reads the refund back from the region, refunds at the provider with the
 * refund's own idempotency key and reports the answer, so a repeated or
 * concurrent kick never refunds twice. The answer carries ids and a status.
 *
 * - 200 `{ refundId, status }` once the provider answered (`pending`,
 *   `succeeded` or `failed`), or `{ refundId, status: 'not_pending' }` when
 *   the refund was already finished (or is unknown).
 * - 503 `{ error, retryable: true }` when the provider or region is
 *   unreachable: the refund stays pending and the reconcile job retries it.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = orderRefundExecuteRequestSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}

	try {
		const result = await executeRestaurantOrderRefund(parsed.data)
		if (result.outcome === 'not_pending') {
			return Response.json(
				{ refundId: result.refundId, status: 'not_pending' },
				{ headers: NO_STORE },
			)
		}
		return Response.json(
			{
				refundId: result.refundId,
				status: result.status,
				...(result.failureCode ? { failureCode: result.failureCode } : {}),
			},
			{ headers: NO_STORE },
		)
	} catch (error) {
		if (error instanceof RestaurantOrderRefundError) {
			return Response.json(
				{ error: error.code, retryable: error.retryable },
				{ status: error.httpStatus, headers: NO_STORE },
			)
		}
		logRestaurantRefundFailure('execute route', error)
		return Response.json(
			{ error: 'refund_unavailable', retryable: true },
			{ status: 503, headers: NO_STORE },
		)
	}
}
