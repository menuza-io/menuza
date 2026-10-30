import crypto from 'node:crypto'
import { and, asc, eq, ne } from 'drizzle-orm'

import { type OperatorOrderRefundRequest } from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	loyaltyPurchases,
	loyaltyRedemptions,
	restaurantOrderRefunds,
	restaurantOrders,
	runTenantTransaction,
	type RestaurantOrder,
	type RestaurantOrderRefund,
} from '@repo/tenant-db'

import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { loyaltySettleQueue } from './loyalty-purchase-service.ts'
import {
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * Refunds of paid online orders, recorded by an operator. The money moves in
 * the payment provider's dashboard: no refund event reaches the region and the
 * region never calls a provider, so this record is the evidence. Each refund
 * adds to `restaurant_orders.refunded_cents`, never past what was paid, and
 * the payment status stays `paid`.
 *
 * Loyalty reads the order's refunded total whenever it reconciles the order,
 * so points come back whatever the loyalty flags say.
 */

export type OrderRefundRecorded = {
	order: RestaurantOrder
	refund: RestaurantOrderRefund
	/** The same key and request came again: nothing new was written. */
	replayed: boolean
}

/** What the operator's token allows when the order carries loyalty. */
export type RefundLoyaltyAccess = {
	/** The token's `refundLoyalty` claim. */
	refundLoyalty: boolean
	impersonated: boolean
}

type TenantTx = Parameters<Parameters<typeof runTenantTransaction>[1]>[0]

/** Whether loyalty earned or spent points on the order. */
async function orderCarriesLoyalty(
	tx: TenantTx,
	orderId: string,
): Promise<boolean> {
	const [purchase] = await tx
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.sourceType, 'restaurant_order'),
				eq(loyaltyPurchases.sourceId, orderId),
			),
		)
		.limit(1)
	if (purchase) return true
	const [redemption] = await tx
		.select({ id: loyaltyRedemptions.id })
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.sourceType, 'restaurant_order'),
				eq(loyaltyRedemptions.sourceId, orderId),
				ne(loyaltyRedemptions.state, 'released'),
			),
		)
		.limit(1)
	return Boolean(redemption)
}

function refundRequestHash(request: OperatorOrderRefundRequest): string {
	return crypto
		.createHash('sha256')
		.update(
			JSON.stringify({
				amountCents: 'amountCents' in request ? request.amountCents : null,
				full: 'full' in request,
				note: request.note,
			}),
		)
		.digest('hex')
}

export async function recordOrderRefund(
	orgId: string,
	orderId: string,
	input: {
		request: OperatorOrderRefundRequest
		actorId: string
		idempotencyKey: string
		/**
		 * Checked inside the serialized transaction that writes the refund, so
		 * loyalty recorded on the order a moment ago cannot slip past it.
		 */
		loyaltyAccess: RefundLoyaltyAccess
		now?: number
	},
): Promise<OrderServiceResult<OrderRefundRecorded>> {
	const db = await getTenantDb(orgId)
	const loyalty = loyaltySettleQueue()
	const requestHash = refundRequestHash(input.request)
	const now = input.now ?? Date.now()

	const result: OrderServiceResult<OrderRefundRecorded> = await runExclusive(
		orgId,
		() =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(db, async (tx) => {
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(
							and(
								eq(restaurantOrders.id, orderId),
								eq(restaurantOrders.orgId, orgId),
							),
						)
						.limit(1)
					if (!order) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}

					// Taking points back and restoring rewards is a loyalty decision too.
					if (await orderCarriesLoyalty(tx, order.id)) {
						if (input.loyaltyAccess.impersonated) {
							return orderFailure(
								403,
								'impersonation_forbidden',
								'Refunds that move loyalty points cannot be recorded while impersonating.',
							)
						}
						if (!input.loyaltyAccess.refundLoyalty) {
							return orderFailure(
								403,
								'loyalty_refund_forbidden',
								'Recording a refund on this order needs the right to manage loyalty redemptions.',
							)
						}
					}

					const [previous] = await tx
						.select()
						.from(restaurantOrderRefunds)
						.where(
							and(
								eq(restaurantOrderRefunds.orderId, order.id),
								eq(restaurantOrderRefunds.idempotencyKey, input.idempotencyKey),
							),
						)
						.limit(1)
					if (previous) {
						if (previous.requestHash !== requestHash) {
							return orderFailure(
								409,
								'idempotency_conflict',
								'This refund was already recorded with different details.',
							)
						}
						return {
							ok: true,
							data: { order, refund: previous, replayed: true },
						}
					}

					// A tab's rounds are handed over and paid with the tab, never online.
					if (order.paymentMethod !== 'online') {
						return orderFailure(
							409,
							'refund_not_online',
							'Only orders paid online can be refunded here.',
						)
					}
					if (order.paymentStatus !== 'paid') {
						return orderFailure(
							409,
							'refund_not_paid',
							'Only a paid order can be refunded.',
						)
					}
					const refundableCents = Math.max(
						0,
						order.totalCents - order.refundedCents,
					)
					if (refundableCents === 0) {
						return orderFailure(
							409,
							'refund_complete',
							'This order is already fully refunded.',
						)
					}
					const amountCents =
						'full' in input.request
							? refundableCents
							: input.request.amountCents
					if (amountCents > refundableCents) {
						return {
							ok: false,
							failure: {
								status: 422,
								code: 'refund_exceeds_payment',
								message: 'That is more than is left to refund.',
								details: { refundableCents },
							},
						}
					}

					const refundedCents = order.refundedCents + amountCents
					const [refund] = await tx
						.insert(restaurantOrderRefunds)
						.values({
							orderId: order.id,
							amountCents,
							currency: order.currency,
							full: refundedCents >= order.totalCents,
							note: input.request.note,
							actorId: input.actorId,
							idempotencyKey: input.idempotencyKey,
							requestHash,
							createdAt: now,
						})
						.returning()
					const [updated] = await tx
						.update(restaurantOrders)
						.set({ refundedCents, updatedAt: new Date(now) })
						.where(eq(restaurantOrders.id, order.id))
						.returning()
					await loyalty.queue(
						tx as unknown as LoyaltyTx,
						{ type: 'restaurant_order', id: order.id },
						now,
					)
					return {
						ok: true,
						data: { order: updated ?? order, refund: refund!, replayed: false },
					}
				}),
			),
	)
	await loyalty.settle(orgId, { now })
	return result
}

export async function listOrderRefunds(
	orgId: string,
	orderId: string,
): Promise<RestaurantOrderRefund[]> {
	const db = await getTenantDb(orgId)
	return db
		.select()
		.from(restaurantOrderRefunds)
		.where(eq(restaurantOrderRefunds.orderId, orderId))
		.orderBy(
			asc(restaurantOrderRefunds.createdAt),
			asc(restaurantOrderRefunds.id),
		)
}

export function operatorOrderRefund(refund: RestaurantOrderRefund) {
	return {
		id: refund.id,
		amountCents: refund.amountCents,
		currency: refund.currency,
		full: refund.full,
		note: refund.note,
		actorId: refund.actorId,
		createdAt: new Date(refund.createdAt).toISOString(),
	}
}
