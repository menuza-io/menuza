import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm'

import { parseTabOrderRef, tabOrderRef } from '@repo/common/qr-ordering'
import {
	disputeBlocksRefund,
	type OrderDisputeStatus,
	type OrderDisputeStatusResponse,
	type OrderProviderRefund,
	type OrderRefundOrigin,
	type OrderRefundStatusResponse,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	qrTabPayments,
	qrTabRefunds,
	qrTabs,
	restaurantOrderRefunds,
	restaurantOrders,
	runTenantTransaction,
	type QrTabRefund,
	type RestaurantOrder,
	type RestaurantOrderRefund,
} from '@repo/tenant-db'

import { queryInChunks } from '../lib/chunked-in.ts'
import { type LoyaltyTx } from '../lib/loyalty-write.ts'
import { kickOrderRefundExecute } from '../lib/order-refund-kick.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { refundDiscountRedemptions } from './discount-apply.ts'
import { loyaltySettleQueue } from './loyalty-purchase-service.ts'
import {
	bookOrderProviderRefundInTx,
	bookTabProviderRefundInTx,
	isUniqueConstraintError,
	orderCarriesLoyalty,
	orderProviderRefundView,
	tabProviderRefundView,
	type BookFailure,
	type QrTab,
	type RefundAmountRequest,
} from './order-refund-book.ts'
import { type RefundLoyaltyAccess } from './order-refund-service.ts'
import {
	orderFailure,
	runExclusive,
	type OrderServiceFailure,
	type OrderServiceResult,
	type OrderTx,
} from './order-service.ts'

/**
 * Provider refunds of online orders and QR tab payments (#80), the region's
 * half. The region books the refund (`pending`, a reservation of the
 * amount), the App calls Stripe or Checkout.com, and the provider's answer
 * (direct, webhook or the App's reconcile job) settles it here, once. The
 * region never calls a provider. Every answer and log line carries ids,
 * amounts, currency and provider ids only.
 */

function fromBook(failure: BookFailure): {
	ok: false
	failure: OrderServiceFailure
} {
	return orderFailure(
		failure.status,
		failure.code,
		failure.message,
		failure.details ? { details: failure.details } : undefined,
	)
}

export type ProviderRefundIntent = {
	refund: OrderProviderRefund
	replayed: boolean
}

export type ProviderRefundIntentInput = {
	orgId: string
	/** The order id, or `tab:<id>`. */
	orderRef: string
	tabPaymentId?: string
	amount: RefundAmountRequest
	note: string | null
	idempotencyKey: string
	origin: OrderRefundOrigin
	actorId: string
	now?: number
	/** Station's checks on the order, inside the booking's transaction. */
	guard?: (order: RestaurantOrder) => OrderServiceFailure | null
	/** Station's record of who asked, in the booking's own transaction. */
	afterBook?: (
		tx: OrderTx,
		order: RestaurantOrder,
		refund: RestaurantOrderRefund,
	) => Promise<void>
	/**
	 * Refuses orders loyalty tracks unless allowed (Station has no loyalty
	 * grant). Absent: the caller (the App) already decided.
	 */
	loyaltyAccess?: RefundLoyaltyAccess
	/** Tell the App to execute it now (region-initiated refunds). */
	kick?: boolean
	/**
	 * A member limited to some locations (the App's refund action): an order
	 * or tab at any other location is the uniform 404, before anything about
	 * it is checked. Null or absent: every location.
	 */
	locationIds?: readonly string[] | null
}

/** Null scope reaches every location; a list reaches only its own. */
function inLocationScope(
	locationIds: readonly string[] | null | undefined,
	locationId: string,
): boolean {
	return locationIds == null || locationIds.includes(locationId)
}

/** Books a pending provider refund of an order or a tab payment. */
export async function createProviderRefundIntent(
	input: ProviderRefundIntentInput,
): Promise<OrderServiceResult<ProviderRefundIntent>> {
	const attempt = () => bookIntent(input)
	let result: OrderServiceResult<ProviderRefundIntent>
	try {
		result = await attempt()
	} catch (error) {
		// Another process booked the same order (one pending refund per order)
		// or the same key between our read and our insert: the second look sees
		// it and answers `refund_pending` or the replay.
		if (!isUniqueConstraintError(error)) throw error
		result = await attempt()
	}
	if (result.ok && !result.data.replayed && input.kick) {
		kickOrderRefundExecute(input.orgId, [result.data.refund.refundId])
	}
	return result
}

async function bookIntent(
	input: ProviderRefundIntentInput,
): Promise<OrderServiceResult<ProviderRefundIntent>> {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	const now = input.now ?? Date.now()
	const tabId = parseTabOrderRef(input.orderRef)
	const booking = {
		amount: input.amount,
		note: input.note,
		idempotencyKey: input.idempotencyKey,
		origin: input.origin,
		actorId: input.actorId,
		now,
	}
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(
				db,
				async (tx): Promise<OrderServiceResult<ProviderRefundIntent>> => {
					if (tabId) {
						const [tab] = await tx
							.select()
							.from(qrTabs)
							.where(eq(qrTabs.id, tabId))
							.limit(1)
						if (!tab || !inLocationScope(input.locationIds, tab.locationId)) {
							return orderFailure(404, 'order_not_found', 'Order not found.')
						}
						const booked = await bookTabProviderRefundInTx(tx, tab, {
							...booking,
							tabPaymentId: input.tabPaymentId,
						})
						if (!booked.ok) return fromBook(booked)
						return {
							ok: true,
							data: {
								refund: tabProviderRefundView(booked.refund),
								replayed: booked.replayed,
							},
						}
					}
					if (input.tabPaymentId) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}
					const [order] = await tx
						.select()
						.from(restaurantOrders)
						.where(
							and(
								eq(restaurantOrders.id, input.orderRef),
								eq(restaurantOrders.orgId, orgId),
							),
						)
						.limit(1)
					if (!order || !inLocationScope(input.locationIds, order.locationId)) {
						return orderFailure(404, 'order_not_found', 'Order not found.')
					}
					const refused = input.guard?.(order)
					if (refused) return { ok: false, failure: refused }
					if (
						input.loyaltyAccess &&
						(await orderCarriesLoyalty(tx, order.id))
					) {
						if (input.loyaltyAccess.impersonated) {
							return orderFailure(
								403,
								'impersonation_forbidden',
								'Refunds that move loyalty points cannot be made while impersonating.',
							)
						}
						if (!input.loyaltyAccess.refundLoyalty) {
							return orderFailure(
								403,
								'loyalty_refund_forbidden',
								'Refunding this order needs the right to manage loyalty redemptions.',
							)
						}
					}
					const booked = await bookOrderProviderRefundInTx(tx, order, booking)
					if (!booked.ok) return fromBook(booked)
					if (!booked.replayed) {
						await input.afterBook?.(tx, order, booked.refund)
					}
					return {
						ok: true,
						data: {
							refund: orderProviderRefundView(booked.refund, order),
							replayed: booked.replayed,
						},
					}
				},
			),
		),
	)
}

// ---------------------------------------------------------------------------
// Settling: refund-status
// ---------------------------------------------------------------------------

export type ProviderRefundStatusInput = {
	orgId: string
	orderId?: string
	refundId?: string
	providerRefundId?: string
	processor?: 'connect' | 'checkout'
	status: 'pending' | 'succeeded' | 'failed'
	failureCode?: string
	amountCents?: number
	currency?: string
	now?: number
}

type FoundRefund =
	| { ledger: 'order'; row: RestaurantOrderRefund }
	| { ledger: 'tab'; row: QrTabRefund }

async function findProviderRefund(
	tx: OrderTx,
	input: ProviderRefundStatusInput,
): Promise<FoundRefund | null> {
	const tabHint = input.orderId ? parseTabOrderRef(input.orderId) : null
	const orderHint = input.orderId && !tabHint ? input.orderId : null
	if (!tabHint) {
		const [row] = await tx
			.select()
			.from(restaurantOrderRefunds)
			.where(
				and(
					eq(restaurantOrderRefunds.kind, 'provider'),
					input.refundId
						? eq(restaurantOrderRefunds.id, input.refundId)
						: eq(
								restaurantOrderRefunds.providerRefundId,
								input.providerRefundId!,
							),
					orderHint ? eq(restaurantOrderRefunds.orderId, orderHint) : undefined,
				),
			)
			.limit(1)
		if (row) return { ledger: 'order', row }
	}
	if (!orderHint) {
		const [row] = await tx
			.select()
			.from(qrTabRefunds)
			.where(
				and(
					input.refundId
						? eq(qrTabRefunds.id, input.refundId)
						: eq(qrTabRefunds.providerRefundId, input.providerRefundId!),
					tabHint ? eq(qrTabRefunds.tabId, tabHint) : undefined,
				),
			)
			.limit(1)
		if (row) return { ledger: 'tab', row }
	}
	return null
}

function refundRef(found: FoundRefund): string {
	return found.ledger === 'order'
		? found.row.orderId
		: tabOrderRef(found.row.tabId)
}

/**
 * The provider's answer for one refund. Idempotent: the first `succeeded`
 * adds the amount to the order's `refunded_cents` and starts what a
 * succeeded refund does (loyalty takes its share of the points back; a full
 * refund gives discount uses back) in the same transaction; any later report
 * changes nothing (`applied: false`). `failed` releases the reservation.
 * Final states win: a `succeeded` after `failed` (or the reverse) is logged
 * by id and answered `applied: false`.
 */
export async function applyProviderRefundStatus(
	input: ProviderRefundStatusInput,
): Promise<OrderServiceResult<OrderRefundStatusResponse>> {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	const loyalty = loyaltySettleQueue()
	const now = input.now ?? Date.now()
	let result: OrderServiceResult<OrderRefundStatusResponse>
	try {
		result = await runExclusive(orgId, () =>
			retryOnSqliteBusy(() =>
				runTenantTransaction(
					db,
					async (
						tx,
					): Promise<OrderServiceResult<OrderRefundStatusResponse>> => {
						const found = await findProviderRefund(tx, input)
						if (!found) {
							return orderFailure(404, 'refund_not_found', 'Refund not found.')
						}
						const row = found.row
						const answer = (
							status: OrderRefundStatusResponse['status'],
							applied: boolean,
						): OrderServiceResult<OrderRefundStatusResponse> => ({
							ok: true,
							data: {
								refundId: row.id,
								orderId: refundRef(found),
								status,
								applied,
							},
						})
						const mismatch =
							(input.processor !== undefined &&
								input.processor !== row.processor) ||
							(input.amountCents !== undefined &&
								input.amountCents !== row.amountCents) ||
							(input.currency !== undefined &&
								input.currency.toUpperCase() !== row.currency.toUpperCase()) ||
							(input.providerRefundId !== undefined &&
								row.providerRefundId !== null &&
								row.providerRefundId !== input.providerRefundId)
						if (mismatch) {
							console.warn('Order refund status does not match the refund', {
								orgId,
								refundId: row.id,
								orderId: refundRef(found),
							})
							return orderFailure(
								409,
								'refund_mismatch',
								'This report does not match the refund.',
							)
						}

						if (row.status !== 'pending') {
							if (input.status !== row.status && input.status !== 'pending') {
								// Final states win: never undo a settled refund.
								console.warn('Order refund already settled', {
									orgId,
									refundId: row.id,
									orderId: refundRef(found),
									stored: row.status,
									reported: input.status,
								})
							}
							return answer(row.status, false)
						}

						const providerRefundId =
							row.providerRefundId ?? input.providerRefundId ?? null
						const table =
							found.ledger === 'order' ? restaurantOrderRefunds : qrTabRefunds
						if (input.status === 'pending') {
							if (row.providerRefundId || !input.providerRefundId) {
								return answer('pending', false)
							}
							await tx
								.update(table)
								.set({ providerRefundId, updatedAt: now })
								.where(and(eq(table.id, row.id), eq(table.status, 'pending')))
							return answer('pending', true)
						}

						const settled = await tx
							.update(table)
							.set({
								status: input.status,
								providerRefundId,
								failureCode:
									input.status === 'failed'
										? (input.failureCode ?? null)
										: null,
								settledAt: now,
								updatedAt: now,
							})
							.where(and(eq(table.id, row.id), eq(table.status, 'pending')))
							.returning({ id: table.id })
						if (settled.length === 0) return answer(row.status, false)

						if (found.ledger === 'order') {
							const [order] = await tx
								.select()
								.from(restaurantOrders)
								.where(
									and(
										eq(restaurantOrders.id, found.row.orderId),
										eq(restaurantOrders.orgId, orgId),
									),
								)
								.limit(1)
							if (order) {
								if (input.status === 'succeeded') {
									const refundedCents = order.refundedCents + row.amountCents
									await tx
										.update(restaurantOrders)
										.set({ refundedCents, updatedAt: new Date(now) })
										.where(eq(restaurantOrders.id, order.id))
									// Exactly what a recorded refund does once it is final.
									if (refundedCents >= order.totalCents) {
										await refundDiscountRedemptions(tx, order.id)
									}
									await loyalty.queue(
										tx as unknown as LoyaltyTx,
										{ type: 'restaurant_order', id: order.id },
										now,
									)
								} else {
									// The amount is refundable again: screens that version on
									// `updated_at` see it.
									await tx
										.update(restaurantOrders)
										.set({ updatedAt: new Date(now) })
										.where(eq(restaurantOrders.id, order.id))
								}
							}
						}
						return answer(input.status, true)
					},
				),
			),
		)
	} catch (error) {
		// Another refund already carries this provider refund id.
		if (!isUniqueConstraintError(error)) throw error
		console.warn('Order refund status names a provider id in use', {
			orgId,
			refundId: input.refundId ?? null,
		})
		return orderFailure(
			409,
			'refund_mismatch',
			'This report does not match the refund.',
		)
	}
	await loyalty.settle(orgId, { now })
	return result
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export type DisputeStatusInput = {
	orgId: string
	orderId?: string
	sessionId?: string
	processor?: 'connect' | 'checkout'
	status: OrderDisputeStatus
	now?: number
}

/**
 * Records a provider dispute on an order or a tab: `disputed_at` the first
 * time, and the latest state. `open` and `lost` block refunds; `won` clears
 * the block. Unknown order or payment: the uniform 404.
 */
export async function applyDisputeStatus(
	input: DisputeStatusInput,
): Promise<OrderServiceResult<OrderDisputeStatusResponse>> {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	const now = input.now ?? Date.now()
	const notFound = () =>
		orderFailure(404, 'order_not_found', 'Order not found.')
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(
				db,
				async (tx): Promise<OrderServiceResult<OrderDisputeStatusResponse>> => {
					let order: RestaurantOrder | null = null
					let tab: QrTab | null = null
					const tabId = input.orderId ? parseTabOrderRef(input.orderId) : null
					if (tabId) {
						const [row] = await tx
							.select()
							.from(qrTabs)
							.where(eq(qrTabs.id, tabId))
							.limit(1)
						tab = row ?? null
					} else if (input.orderId) {
						const [row] = await tx
							.select()
							.from(restaurantOrders)
							.where(
								and(
									eq(restaurantOrders.id, input.orderId),
									eq(restaurantOrders.orgId, orgId),
								),
							)
							.limit(1)
						order = row ?? null
					} else if (input.sessionId) {
						const sessionId = input.sessionId
						const [row] = await tx
							.select()
							.from(restaurantOrders)
							.where(
								and(
									eq(restaurantOrders.orgId, orgId),
									or(
										eq(restaurantOrders.paymentSessionId, sessionId),
										eq(restaurantOrders.paymentId, sessionId),
									),
									input.processor
										? eq(restaurantOrders.paymentProcessor, input.processor)
										: undefined,
								),
							)
							.limit(1)
						order = row ?? null
						if (!order) {
							const [settled] = await tx
								.select()
								.from(qrTabs)
								.where(
									and(
										eq(qrTabs.paymentSessionId, sessionId),
										input.processor
											? eq(qrTabs.paymentProcessor, input.processor)
											: undefined,
									),
								)
								.limit(1)
							tab = settled ?? null
						}
						if (!order && !tab) {
							const [payment] = await tx
								.select({ tabId: qrTabPayments.tabId })
								.from(qrTabPayments)
								.where(
									and(
										eq(qrTabPayments.sessionId, sessionId),
										input.processor
											? eq(qrTabPayments.processor, input.processor)
											: undefined,
									),
								)
								.limit(1)
							if (payment) {
								const [row] = await tx
									.select()
									.from(qrTabs)
									.where(eq(qrTabs.id, payment.tabId))
									.limit(1)
								tab = row ?? null
							}
						}
					}

					if (order) {
						if (
							input.orderId &&
							input.processor &&
							order.paymentProcessor !== input.processor
						) {
							return notFound()
						}
						const applied =
							order.disputeStatus !== input.status || !order.disputedAt
						if (applied) {
							await tx
								.update(restaurantOrders)
								.set({
									disputeStatus: input.status,
									disputedAt: order.disputedAt ?? new Date(now),
									updatedAt: new Date(now),
								})
								.where(eq(restaurantOrders.id, order.id))
						}
						return {
							ok: true,
							data: {
								orderId: order.id,
								disputeStatus: input.status,
								disputed: disputeBlocksRefund(input.status),
								applied,
							},
						}
					}
					if (tab) {
						const applied =
							tab.disputeStatus !== input.status || !tab.disputedAt
						if (applied) {
							await tx
								.update(qrTabs)
								.set({
									disputeStatus: input.status,
									disputedAt: tab.disputedAt ?? now,
									updatedAt: now,
								})
								.where(eq(qrTabs.id, tab.id))
						}
						return {
							ok: true,
							data: {
								orderId: tabOrderRef(tab.id),
								disputeStatus: input.status,
								disputed: disputeBlocksRefund(input.status),
								applied,
							},
						}
					}
					return notFound()
				},
			),
		),
	)
}

// ---------------------------------------------------------------------------
// Pending listing (App execute + reconcile)
// ---------------------------------------------------------------------------

export const PENDING_REFUNDS_DEFAULT_LIMIT = 50

/**
 * Provider refunds still `pending`, orders and tabs, oldest first. `refundId`
 * narrows to one; `olderThanMs` keeps those not written within that long
 * (`coalesce(updated_at, created_at)`).
 */
export async function listPendingProviderRefunds(input: {
	orgId: string
	refundId?: string
	olderThanMs?: number
	limit?: number
	now?: number
}): Promise<OrderProviderRefund[]> {
	const db = await getTenantDb(input.orgId)
	const now = input.now ?? Date.now()
	const limit = input.limit ?? PENDING_REFUNDS_DEFAULT_LIMIT
	const cutoff =
		input.olderThanMs !== undefined ? now - input.olderThanMs : null
	const orderRows = await db
		.select()
		.from(restaurantOrderRefunds)
		.where(
			and(
				eq(restaurantOrderRefunds.kind, 'provider'),
				eq(restaurantOrderRefunds.status, 'pending'),
				input.refundId
					? eq(restaurantOrderRefunds.id, input.refundId)
					: undefined,
				cutoff !== null
					? lte(
							sql`coalesce(${restaurantOrderRefunds.updatedAt}, ${restaurantOrderRefunds.createdAt})`,
							cutoff,
						)
					: undefined,
			),
		)
		.orderBy(asc(restaurantOrderRefunds.createdAt))
		.limit(limit)
	const tabRows = await db
		.select()
		.from(qrTabRefunds)
		.where(
			and(
				eq(qrTabRefunds.status, 'pending'),
				input.refundId ? eq(qrTabRefunds.id, input.refundId) : undefined,
				cutoff !== null
					? lte(
							sql`coalesce(${qrTabRefunds.updatedAt}, ${qrTabRefunds.createdAt})`,
							cutoff,
						)
					: undefined,
			),
		)
		.orderBy(asc(qrTabRefunds.createdAt))
		.limit(limit)
	const paymentIds = new Map<string, string | null>()
	const orderIds = [...new Set(orderRows.map((row) => row.orderId))]
	const orders = await queryInChunks(orderIds, (chunk) =>
		db
			.select({
				id: restaurantOrders.id,
				paymentId: restaurantOrders.paymentId,
			})
			.from(restaurantOrders)
			.where(
				and(
					inArray(restaurantOrders.id, chunk),
					eq(restaurantOrders.orgId, input.orgId),
				),
			),
	)
	for (const order of orders) paymentIds.set(order.id, order.paymentId)
	const refunds = [
		...orderRows
			.filter((row) => paymentIds.has(row.orderId))
			.map((row) => ({
				at: row.createdAt,
				view: orderProviderRefundView(row, {
					paymentId: paymentIds.get(row.orderId) ?? null,
				}),
			})),
		...tabRows.map((row) => ({
			at: row.createdAt,
			view: tabProviderRefundView(row),
		})),
	]
	refunds.sort((a, b) => a.at - b.at)
	return refunds.slice(0, limit).map((entry) => entry.view)
}
