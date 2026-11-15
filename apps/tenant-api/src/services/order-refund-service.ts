import crypto from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'

import {
	effectiveRefundRow,
	type OperatorOrderRefundRequest,
	type OrderRefundSummary,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
	runTenantTransaction,
	type RestaurantOrder,
	type RestaurantOrderRefund,
} from '@repo/tenant-db'

import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import { queryInChunks } from '../lib/chunked-in.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { refundDiscountRedemptions } from './discount-apply.ts'
import { loyaltySettleQueue } from './loyalty-purchase-service.ts'
import {
	orderCarriesLoyalty,
	orderRefundableCents,
	orderRefundedNetCents,
	orderRefundSummary,
	orderServiceFeeChargeCents,
	pendingOrderRefundCentsInTx,
	refundAmountWithServiceFee,
	serviceFeeRefundedCentsInTx,
} from './order-refund-book.ts'
import {
	orderFailure,
	runExclusive,
	type OrderServiceResult,
	type OrderTx,
	type OrderWriteHooks,
} from './order-service.ts'

/**
 * Refunds recorded by a person for orders paid at handoff (cash or card at the
 * counter, `markPaid`): the money went back outside Menuza, so the record is
 * the evidence (`kind = record`, `status = succeeded` at once). The region
 * never calls a provider. Orders paid online are refunded through the payment
 * provider instead (`order-provider-refund-service.ts`, decision 4): a record
 * of one is refused with `refund_requires_provider`. Each refund adds to
 * `restaurant_orders.refunded_cents`, never past what was paid, and the
 * payment status stays `paid`.
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

export { orderCarriesLoyalty }

function refundRequestHash(request: OperatorOrderRefundRequest): string {
	return crypto
		.createHash('sha256')
		.update(
			JSON.stringify({
				amountCents: 'amountCents' in request ? request.amountCents : null,
				full: 'full' in request,
				note: request.note,
				// Only when set, so the hash of a request without it never changes.
				...('includeServiceFee' in request && request.includeServiceFee
					? { includeServiceFee: true }
					: {}),
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
		/** Station's checks and record, in the refund's own transaction. */
		hooks?: OrderWriteHooks
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

					const refused = input.hooks?.guard?.(order)
					if (refused) return { ok: false, failure: refused }

					// Online money goes back through the payment provider.
					if (order.paymentMethod === 'online') {
						return orderFailure(
							409,
							'refund_requires_provider',
							'This order was paid online. Refund it through the payment provider.',
						)
					}
					// A tab's rounds are paid with the tab, never one round alone.
					if (order.tabId) {
						return orderFailure(
							409,
							'order_not_refundable',
							'This order is on a table tab. Refund the tab instead.',
						)
					}
					if (order.paymentStatus !== 'paid') {
						return orderFailure(
							409,
							'refund_not_paid',
							'Only a paid order can be refunded.',
						)
					}
					const pendingCents = await pendingOrderRefundCentsInTx(
						tx as unknown as OrderTx,
						order.id,
					)
					const refundableCents = orderRefundableCents(order, pendingCents)
					if (refundableCents === 0) {
						return orderFailure(
							409,
							'refund_complete',
							'This order is already fully refunded.',
						)
					}
					const { amountCents, serviceFeeCents } = refundAmountWithServiceFee({
						amount: input.request,
						refundableCents,
						feeChargeCents: orderServiceFeeChargeCents(order),
						feeRefundedCents: await serviceFeeRefundedCentsInTx(
							tx as unknown as OrderTx,
							order.id,
						),
					})
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
					const fullyBack =
						orderRefundedNetCents({ ...order, refundedCents }) >=
						order.totalCents
					const [refund] = await tx
						.insert(restaurantOrderRefunds)
						.values({
							orderId: order.id,
							amountCents,
							serviceFeeCents,
							currency: order.currency,
							full: fullyBack,
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
					if (fullyBack) {
						await refundDiscountRedemptions(tx, order.id)
					}
					await loyalty.queue(
						tx as unknown as LoyaltyTx,
						{ type: 'restaurant_order', id: order.id },
						now,
					)
					await input.hooks?.afterWrite?.(tx, order, updated ?? order)
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
	// A provider refund reversed after it succeeded reads failed, with the
	// reversal's code, so screens offer to refund it again.
	const effective = effectiveRefundRow(refund)
	return {
		id: refund.id,
		amountCents: refund.amountCents,
		currency: refund.currency,
		full: refund.full,
		note: refund.note,
		actorId: refund.actorId,
		/** The part of the amount that is the service fee and its tax (#123). */
		serviceFeeCents: refund.serviceFeeCents,
		createdAt: new Date(refund.createdAt).toISOString(),
		/** `record` (money returned outside Menuza) or `provider`. */
		kind: refund.kind,
		/** Only `succeeded` refunds count in `refundedCents`. */
		status: effective.status as RestaurantOrderRefund['status'],
		origin: refund.origin,
		failureCode: effective.failureCode,
		settledAt:
			refund.settledAt != null
				? new Date(refund.settledAt).toISOString()
				: null,
		/** When the provider reversed it after it succeeded; null otherwise. */
		reversedAt:
			refund.reversedAt != null
				? new Date(refund.reversedAt).toISOString()
				: null,
	}
}

/**
 * Provider refunds still pending on the order (their amounts are reserved:
 * not refundable again, not yet in `refundedCents`).
 */
export function pendingRefundCents(
	refunds: readonly Pick<RestaurantOrderRefund, 'amountCents' | 'status'>[],
): number {
	let total = 0
	for (const refund of refunds) {
		if (refund.status === 'pending') total += refund.amountCents
	}
	return total
}

/** Refund rows of many orders (a list page), by order id. */
export async function listRefundsForOrders(
	orgId: string,
	orderIds: readonly string[],
): Promise<Map<string, RestaurantOrderRefund[]>> {
	const byOrder = new Map<string, RestaurantOrderRefund[]>()
	if (orderIds.length === 0) return byOrder
	const db = await getTenantDb(orgId)
	const rows = await queryInChunks([...new Set(orderIds)], (chunk) =>
		db
			.select()
			.from(restaurantOrderRefunds)
			.where(inArray(restaurantOrderRefunds.orderId, chunk))
			.orderBy(
				asc(restaurantOrderRefunds.createdAt),
				asc(restaurantOrderRefunds.id),
			),
	)
	for (const row of rows) {
		const list = byOrder.get(row.orderId) ?? []
		list.push(row)
		byOrder.set(row.orderId, list)
	}
	return byOrder
}

/**
 * The refund fields of the operator order JSON (list rows and detail): the
 * rows, what waits on the provider, what is still refundable and a summary.
 */
export function operatorOrderRefundFields(
	order: RestaurantOrder,
	refunds: readonly RestaurantOrderRefund[],
) {
	const summary = orderRefundSummary(order, refunds)
	return {
		refunds: refunds.map(operatorOrderRefund),
		refundPendingCents: summary.pendingCents,
		refundableCents: summary.refundableCents,
		refundStatus: summary.refundStatus,
		refundFailureCode: summary.failureCode,
	}
}

/** What the guest and operator views show of an order's refunds. */
export async function orderRefundGlance(
	orgId: string,
	order: RestaurantOrder,
): Promise<{
	refundStatus: OrderRefundSummary['refundStatus']
	pendingCents: number
}> {
	const summary = orderRefundSummary(
		order,
		await listOrderRefunds(orgId, order.id),
	)
	return {
		refundStatus: summary.refundStatus,
		pendingCents: summary.pendingCents,
	}
}
