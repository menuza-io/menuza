import { and, eq, isNull } from 'drizzle-orm'

import { type OperatorOrderRefundRequest } from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'

import {
	applyProviderRefundStatus,
	createProviderRefundIntent,
} from './order-provider-refund-service.ts'
import {
	type OrderRefundRecorded,
	type RefundLoyaltyAccess,
} from './order-refund-service.ts'
import { type OrderServiceResult } from './order-service.ts'

/**
 * Tests only: refunds a paid online order the way the App does (#80), in one
 * call: books the provider refund (`refund-intent`) and reports it
 * `succeeded` (`refund-status`), then answers like `recordOrderRefund` did.
 * A fixture order paid online without a bound Checkout Session gets one first,
 * as every real paid online order has.
 */
export async function refundOrderThroughProvider(
	orgId: string,
	orderId: string,
	input: {
		request: OperatorOrderRefundRequest
		actorId: string
		idempotencyKey: string
		loyaltyAccess?: RefundLoyaltyAccess
		now?: number
	},
): Promise<OrderServiceResult<OrderRefundRecorded>> {
	const db = await getTenantDb(orgId)
	await db
		.update(restaurantOrders)
		.set({
			paymentProcessor: 'connect',
			paymentSessionId: `cs_fixture_${orderId}`,
		})
		.where(
			and(
				eq(restaurantOrders.id, orderId),
				eq(restaurantOrders.paymentMethod, 'online'),
				isNull(restaurantOrders.paymentSessionId),
			),
		)
	const booked = await createProviderRefundIntent({
		orgId,
		orderRef: orderId,
		amount:
			'full' in input.request
				? { full: true }
				: {
						amountCents: input.request.amountCents,
						...(input.request.includeServiceFee
							? { includeServiceFee: true }
							: {}),
					},
		note: input.request.note,
		idempotencyKey: input.idempotencyKey,
		origin: 'operator',
		actorId: input.actorId,
		loyaltyAccess: input.loyaltyAccess,
		now: input.now,
	})
	if (!booked.ok) return booked
	const settled = await applyProviderRefundStatus({
		orgId,
		refundId: booked.data.refund.refundId,
		status: 'succeeded',
		now: input.now,
	})
	if (!settled.ok) return settled
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
	const [refund] = await db
		.select()
		.from(restaurantOrderRefunds)
		.where(eq(restaurantOrderRefunds.id, booked.data.refund.refundId))
	return {
		ok: true,
		data: { order: order!, refund: refund!, replayed: booked.data.replayed },
	}
}
