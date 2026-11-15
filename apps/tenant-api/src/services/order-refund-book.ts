import crypto from 'node:crypto'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { tabOrderRef } from '@repo/common/qr-ordering'
import {
	disputeBlocksRefund,
	refundableAmountCents,
	summarizeOrderRefunds,
	type OrderProviderRefund,
	type OrderRefundOrigin,
	type OrderRefundSummary,
} from '@repo/common/restaurant-orders'
import {
	loyaltyPurchases,
	loyaltyRedemptions,
	qrTabPayments,
	qrTabRefunds,
	qrTabs,
	restaurantOrderRefunds,
	restaurantOrders,
	type QrTabRefund,
	type RestaurantOrder,
	type RestaurantOrderRefund,
} from '@repo/tenant-db'

import { type OrderTx } from './order-service.ts'

/**
 * The one place that decides what an order (or a tab payment) can still give
 * back, and that books a provider refund (#80) inside the caller's
 * transaction. No service imports at runtime: `order-service.ts` (cancel with
 * a refund), `order-refund-service.ts` (the record path) and
 * `order-provider-refund-service.ts` (the system routes) all build on it.
 *
 * Refundable = paid − succeeded (`refunded_cents`) − pending provider
 * refunds + reversed ones (`refund_reversed_cents`). A `pending` row reserves
 * its amount; `failed` gives it back; only `succeeded` ever adds to
 * `refunded_cents`, which never shrinks: a succeeded refund the provider
 * reports failed afterwards is marked reversed and counted back here.
 */

export type QrTab = typeof qrTabs.$inferSelect
type QrTabPayment = typeof qrTabPayments.$inferSelect

/** Whether loyalty earned or spent points on the order. */
export async function orderCarriesLoyalty(
	tx: OrderTx,
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

/** What was captured for the order: its total once paid, else nothing. */
export function orderPaidCents(
	order: Pick<RestaurantOrder, 'paymentStatus' | 'totalCents'>,
): number {
	return order.paymentStatus === 'paid' ? order.totalCents : 0
}

/**
 * What is really back on the order: succeeded refunds less those the
 * provider reversed afterwards. Views and "every cent back" checks use this,
 * never `refunded_cents` alone.
 */
export function orderRefundedNetCents(
	order: Pick<RestaurantOrder, 'refundedCents' | 'refundReversedCents'>,
): number {
	return Math.max(0, order.refundedCents - (order.refundReversedCents ?? 0))
}

/** What the order can still give back, given what waits on the provider. */
export function orderRefundableCents(
	order: Pick<
		RestaurantOrder,
		'paymentStatus' | 'totalCents' | 'refundedCents' | 'refundReversedCents'
	>,
	pendingCents: number,
): number {
	return refundableAmountCents({
		paidCents: orderPaidCents(order),
		refundedCents: order.refundedCents,
		reversedCents: order.refundReversedCents ?? 0,
		pendingCents,
	})
}

/** The order's refund state from its stored total and its refund rows. */
export function orderRefundSummary(
	order: Pick<
		RestaurantOrder,
		'paymentStatus' | 'totalCents' | 'refundedCents' | 'refundReversedCents'
	>,
	refunds: readonly Pick<
		RestaurantOrderRefund,
		| 'amountCents'
		| 'status'
		| 'kind'
		| 'failureCode'
		| 'createdAt'
		| 'reversedAt'
		| 'reversalCode'
	>[],
): OrderRefundSummary {
	return summarizeOrderRefunds(
		{
			paidCents: orderPaidCents(order),
			refundedCents: order.refundedCents,
			reversedCents: order.refundReversedCents ?? 0,
		},
		refunds,
	)
}

/** Provider refunds of the order still waiting on the provider. */
export async function pendingOrderRefundCentsInTx(
	tx: OrderTx,
	orderId: string,
): Promise<number> {
	const [row] = await tx
		.select({
			total: sql<number>`coalesce(sum(${restaurantOrderRefunds.amountCents}), 0)`,
		})
		.from(restaurantOrderRefunds)
		.where(
			and(
				eq(restaurantOrderRefunds.orderId, orderId),
				eq(restaurantOrderRefunds.status, 'pending'),
			),
		)
	return Number(row?.total ?? 0)
}

/**
 * What the order charged for its service fee (#123): the fee plus its tax,
 * except when prices include tax (the tax is inside the fee then). 0 for an
 * order with no fee. The inclusive test is the one the totals follow: the
 * total never added the tax on top.
 */
export function orderServiceFeeChargeCents(
	order: Pick<
		RestaurantOrder,
		| 'serviceFeeCents'
		| 'serviceFeeTaxCents'
		| 'taxCents'
		| 'totalCents'
		| 'subtotalCents'
		| 'loyaltyDiscountCents'
		| 'discountCents'
		| 'deliveryDiscountCents'
		| 'tipCents'
		| 'deliveryFeeCents'
	>,
): number {
	if (order.serviceFeeCents <= 0) return 0
	const inclusive =
		order.taxCents > 0 &&
		order.totalCents ===
			order.subtotalCents -
				order.loyaltyDiscountCents -
				order.discountCents +
				order.tipCents +
				order.deliveryFeeCents -
				order.deliveryDiscountCents +
				order.serviceFeeCents
	return order.serviceFeeCents + (inclusive ? 0 : order.serviceFeeTaxCents)
}

/**
 * The service fee already given back or reserved on an order: the fee part of
 * every pending or succeeded refund (a refund the provider reversed counts as
 * given back no more).
 */
export async function serviceFeeRefundedCentsInTx(
	tx: OrderTx,
	orderId: string,
): Promise<number> {
	const [row] = await tx
		.select({
			total: sql<number>`coalesce(sum(${restaurantOrderRefunds.serviceFeeCents}), 0)`,
		})
		.from(restaurantOrderRefunds)
		.where(
			and(
				eq(restaurantOrderRefunds.orderId, orderId),
				inArray(restaurantOrderRefunds.status, ['pending', 'succeeded']),
				isNull(restaurantOrderRefunds.reversedAt),
			),
		)
	return Number(row?.total ?? 0)
}

/**
 * The amount a refund request books and the part of it that is the service
 * fee. A full refund is everything still refundable (so it includes the fee
 * that is left); a partial one adds the fee that is left only when the
 * operator ticked "include service fee", on top of the amount typed.
 */
export function refundAmountWithServiceFee(input: {
	amount: RefundAmountRequest
	refundableCents: number
	/** The order's fee charge, and how much of it earlier refunds took. */
	feeChargeCents: number
	feeRefundedCents: number
}): { amountCents: number; serviceFeeCents: number } {
	const feeLeft = Math.max(0, input.feeChargeCents - input.feeRefundedCents)
	if ('full' in input.amount) {
		return {
			amountCents: input.refundableCents,
			serviceFeeCents: Math.min(feeLeft, input.refundableCents),
		}
	}
	const serviceFeeCents = input.amount.includeServiceFee ? feeLeft : 0
	return {
		amountCents: input.amount.amountCents + serviceFeeCents,
		serviceFeeCents,
	}
}

export function refundRequestHash(parts: Record<string, unknown>): string {
	return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function isUniqueConstraintError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; current && depth < 5; depth++) {
		const message = current instanceof Error ? current.message : String(current)
		if (/UNIQUE constraint failed/i.test(message)) return true
		current = (current as { cause?: unknown }).cause
	}
	return false
}

export type BookFailure = {
	ok: false
	status: number
	code: string
	message: string
	details?: Record<string, unknown>
}

function bookFailure(
	status: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): BookFailure {
	return { ok: false, status, code, message, ...(details ? { details } : {}) }
}

export type RefundAmountRequest =
	| { full: true }
	| {
			amountCents: number
			/** Add the order's service fee on top of `amountCents` (#123). */
			includeServiceFee?: boolean
	  }

export type ProviderRefundBooking = {
	amount: RefundAmountRequest
	note: string | null
	idempotencyKey: string
	origin: OrderRefundOrigin
	/** User id (operator), `staff:<id>` (Station), `guest` or `system`. */
	actorId: string
	now: number
}

export type OrderRefundBooked = {
	ok: true
	refund: RestaurantOrderRefund
	replayed: boolean
}

/**
 * Books a `pending` provider refund of a paid online order. The caller holds
 * the org lock and the transaction and has loaded `order` inside it. Touches
 * the order's `updated_at` so screens that version on it see the change.
 */
export async function bookOrderProviderRefundInTx(
	tx: OrderTx,
	order: RestaurantOrder,
	input: ProviderRefundBooking,
): Promise<OrderRefundBooked | BookFailure> {
	const requestHash = refundRequestHash({
		kind: 'provider',
		amountCents:
			'amountCents' in input.amount ? input.amount.amountCents : null,
		full: 'full' in input.amount,
		note: input.note,
		// Only when set, so the hash of a request without it never changes.
		...('includeServiceFee' in input.amount && input.amount.includeServiceFee
			? { includeServiceFee: true }
			: {}),
	})
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
		if (previous.kind !== 'provider' || previous.requestHash !== requestHash) {
			return bookFailure(
				409,
				'idempotency_conflict',
				'This refund was already requested with different details.',
			)
		}
		return { ok: true, refund: previous, replayed: true }
	}

	if (
		order.paymentMethod !== 'online' ||
		order.paymentStatus !== 'paid' ||
		order.tabId ||
		!order.paymentSessionId ||
		!order.paymentProcessor
	) {
		return bookFailure(
			409,
			'order_not_refundable',
			'Only an order paid online can be refunded through the payment provider.',
		)
	}
	if (disputeBlocksRefund(order.disputeStatus)) {
		return bookFailure(
			409,
			'payment_disputed',
			'This payment is disputed. It cannot be refunded while the dispute is open or after it was lost.',
		)
	}
	const pendingCents = await pendingOrderRefundCentsInTx(tx, order.id)
	if (pendingCents > 0) {
		return bookFailure(
			409,
			'refund_pending',
			'A refund of this order is already waiting on the payment provider.',
		)
	}
	const refundableCents = orderRefundableCents(order, pendingCents)
	if (refundableCents === 0) {
		return bookFailure(
			409,
			'refund_complete',
			'This order is already fully refunded.',
		)
	}
	const { amountCents, serviceFeeCents } = refundAmountWithServiceFee({
		amount: input.amount,
		refundableCents,
		feeChargeCents: orderServiceFeeChargeCents(order),
		feeRefundedCents: await serviceFeeRefundedCentsInTx(tx, order.id),
	})
	if (amountCents > refundableCents) {
		return bookFailure(
			422,
			'refund_exceeds_payment',
			'That is more than is left to refund.',
			{ refundableCents },
		)
	}

	const [refund] = await tx
		.insert(restaurantOrderRefunds)
		.values({
			orderId: order.id,
			amountCents,
			serviceFeeCents,
			currency: order.currency,
			full: orderRefundedNetCents(order) + amountCents >= order.totalCents,
			note: input.note,
			actorId: input.actorId,
			idempotencyKey: input.idempotencyKey,
			requestHash,
			createdAt: input.now,
			kind: 'provider',
			status: 'pending',
			origin: input.origin,
			processor: order.paymentProcessor,
			sessionId: order.paymentSessionId,
			updatedAt: input.now,
		})
		.returning()
	await tx
		.update(restaurantOrders)
		.set({ updatedAt: new Date(input.now) })
		.where(eq(restaurantOrders.id, order.id))
	return { ok: true, refund: refund!, replayed: false }
}

/** The idempotency key of the refund a cancel books (one per order). */
export function cancelRefundKey(orderId: string): string {
	return `cancel:${orderId}`
}

/**
 * The key of the rest of a cancel's full refund, booked once the refund that
 * was pending at the cancel became final (one per order: a cancel is final).
 */
export function owedCancelRefundKey(orderId: string): string {
	return `cancel:${orderId}:rest`
}

/** How many times the rest of a cancel's refund is booked again after the provider reversed it. */
const OWED_CANCEL_REFUND_ATTEMPTS = 5

/**
 * The key the next owed refund of a cancel books under: `cancel:<id>:rest`,
 * and `cancel:<id>:rest:2`, `:3`... once an earlier one succeeded and was then
 * reversed by the provider (a reversed refund keeps its key, so the next try
 * needs its own). A key whose refund is not reversed is returned as is: the
 * booking replays it, which is what keeps a repeated pass from booking twice.
 * Null once every attempt was reversed.
 */
async function nextOwedCancelRefundKey(
	tx: OrderTx,
	orderId: string,
): Promise<string | null> {
	const base = owedCancelRefundKey(orderId)
	for (let attempt = 1; attempt <= OWED_CANCEL_REFUND_ATTEMPTS; attempt += 1) {
		const key = attempt === 1 ? base : `${base}:${attempt}`
		const [row] = await tx
			.select({ reversedAt: restaurantOrderRefunds.reversedAt })
			.from(restaurantOrderRefunds)
			.where(
				and(
					eq(restaurantOrderRefunds.orderId, orderId),
					eq(restaurantOrderRefunds.idempotencyKey, key),
				),
			)
			.limit(1)
		if (!row || row.reversedAt == null) return key
	}
	return null
}

export type OwedCancelRefund = {
	/** The refund booked now (the caller kicks the App after commit). */
	refund: RestaurantOrderRefund | null
	/** Why none was booked: `refund_pending` keeps the order marked. */
	code: string | null
}

/**
 * Whether a cancel's full refund that could not be booked now is still owed
 * (`cancel_refund_due_at`): another provider refund of the order is pending
 * (one at a time), or the payment has an open dispute (no refund while it is
 * disputed; a won dispute books it, a lost one gave the money back).
 */
export function cancelRefundStaysOwed(
	code: string,
	order: Pick<RestaurantOrder, 'disputeStatus'>,
): boolean {
	return (
		code === 'refund_pending' ||
		(code === 'payment_disputed' && order.disputeStatus === 'open')
	)
}

/**
 * Books what a cancel still owes (`cancel_refund_due_at`): a full refund of
 * whatever is refundable now (paid − succeeded − pending + reversed), once no
 * other provider refund waits and no dispute is open. Clears the mark when
 * booked, or when nothing can be refunded (nothing left, a lost dispute, the
 * order no longer paid online), logging the latter by id. Keeps the mark
 * while another refund is pending or a dispute is open. Runs inside the
 * caller's transaction (the order read in it), under the org lock.
 */
export async function bookOwedCancelRefundInTx(
	tx: OrderTx,
	order: RestaurantOrder,
	now: number,
): Promise<OwedCancelRefund> {
	if (!order.cancelRefundDueAt) return { refund: null, code: null }
	const key = await nextOwedCancelRefundKey(tx, order.id)
	if (!key) {
		// Reversed again and again: stop owing it, a person looks at the order.
		await tx
			.update(restaurantOrders)
			.set({ cancelRefundDueAt: null, updatedAt: new Date(now) })
			.where(eq(restaurantOrders.id, order.id))
		console.warn('Owed cancel refund reversed too often', {
			orderId: order.id,
		})
		return { refund: null, code: 'reversal_limit' }
	}
	const booked = await bookOrderProviderRefundInTx(tx, order, {
		amount: { full: true },
		note: null,
		idempotencyKey: key,
		origin: 'system',
		actorId: 'system',
		now,
	})
	if (!booked.ok && cancelRefundStaysOwed(booked.code, order)) {
		return { refund: null, code: booked.code }
	}
	await tx
		.update(restaurantOrders)
		.set({ cancelRefundDueAt: null, updatedAt: new Date(now) })
		.where(eq(restaurantOrders.id, order.id))
	if (!booked.ok) {
		if (booked.code !== 'refund_complete') {
			console.warn('Owed cancel refund not booked', {
				orderId: order.id,
				code: booked.code,
			})
		}
		return { refund: null, code: booked.code }
	}
	return { refund: booked.replayed ? null : booked.refund, code: null }
}

/** The tab payment a refund names: the settling one, or a review row. */
type TabPaymentRef = {
	tabPaymentId: string | null
	amountCents: number
	currency: string
	processor: 'connect' | 'checkout'
	sessionId: string
}

export type TabRefundBooked = {
	ok: true
	refund: QrTabRefund
	replayed: boolean
}

function processorOf(value: string | null): 'connect' | 'checkout' | null {
	return value === 'connect' || value === 'checkout' ? value : null
}

async function tabPaymentRef(
	tx: OrderTx,
	tab: QrTab,
	tabPaymentId: string | undefined,
): Promise<TabPaymentRef | BookFailure> {
	if (tabPaymentId) {
		const [payment] = (await tx
			.select()
			.from(qrTabPayments)
			.where(
				and(
					eq(qrTabPayments.id, tabPaymentId),
					eq(qrTabPayments.tabId, tab.id),
				),
			)
			.limit(1)) as QrTabPayment[]
		const processor = processorOf(payment?.processor ?? null)
		if (!payment || !processor) {
			return bookFailure(404, 'order_not_found', 'Order not found.')
		}
		return {
			tabPaymentId: payment.id,
			amountCents: payment.amountCents,
			currency: payment.currency,
			processor,
			sessionId: payment.sessionId,
		}
	}
	const processor = processorOf(tab.paymentProcessor)
	if (
		tab.paymentMethod !== 'online' ||
		tab.paymentStatus !== 'paid' ||
		!tab.paymentSessionId ||
		!processor
	) {
		return bookFailure(
			409,
			'order_not_refundable',
			'Only a tab paid online can be refunded through the payment provider.',
		)
	}
	return {
		tabPaymentId: null,
		amountCents: tab.paymentAmountCents ?? tab.totalCents,
		currency: tab.currency,
		processor,
		sessionId: tab.paymentSessionId,
	}
}

/**
 * Refunds of one payment of a tab: succeeded (less those the provider
 * reversed afterwards, which are refundable again) and pending.
 */
async function tabPaymentRefunded(
	tx: OrderTx,
	tabId: string,
	tabPaymentId: string | null,
): Promise<{ succeeded: number; pending: number }> {
	const rows = await tx
		.select({
			status: sql<string>`case when ${qrTabRefunds.reversedAt} is not null then 'reversed' else ${qrTabRefunds.status} end`,
			total: sql<number>`coalesce(sum(${qrTabRefunds.amountCents}), 0)`,
		})
		.from(qrTabRefunds)
		.where(
			and(
				eq(qrTabRefunds.tabId, tabId),
				tabPaymentId === null
					? isNull(qrTabRefunds.tabPaymentId)
					: eq(qrTabRefunds.tabPaymentId, tabPaymentId),
			),
		)
		.groupBy(
			sql`case when ${qrTabRefunds.reversedAt} is not null then 'reversed' else ${qrTabRefunds.status} end`,
		)
	let succeeded = 0
	let pending = 0
	for (const row of rows) {
		if (row.status === 'succeeded') succeeded += Number(row.total)
		if (row.status === 'pending') pending += Number(row.total)
	}
	return { succeeded, pending }
}

/**
 * Books a `pending` provider refund of one online payment a QR tab took
 * (decision 11: per payment, never per round). One pending refund per tab.
 */
export async function bookTabProviderRefundInTx(
	tx: OrderTx,
	tab: QrTab,
	input: ProviderRefundBooking & { tabPaymentId?: string },
): Promise<TabRefundBooked | BookFailure> {
	const requestHash = refundRequestHash({
		kind: 'provider',
		tabPaymentId: input.tabPaymentId ?? null,
		amountCents:
			'amountCents' in input.amount ? input.amount.amountCents : null,
		full: 'full' in input.amount,
		note: input.note,
	})
	const [previous] = await tx
		.select()
		.from(qrTabRefunds)
		.where(
			and(
				eq(qrTabRefunds.tabId, tab.id),
				eq(qrTabRefunds.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1)
	if (previous) {
		if (previous.requestHash !== requestHash) {
			return bookFailure(
				409,
				'idempotency_conflict',
				'This refund was already requested with different details.',
			)
		}
		return { ok: true, refund: previous, replayed: true }
	}

	const payment = await tabPaymentRef(tx, tab, input.tabPaymentId)
	if ('ok' in payment) return payment
	if (disputeBlocksRefund(tab.disputeStatus)) {
		return bookFailure(
			409,
			'payment_disputed',
			'This payment is disputed. It cannot be refunded while the dispute is open or after it was lost.',
		)
	}
	const [pendingOnTab] = await tx
		.select({ id: qrTabRefunds.id })
		.from(qrTabRefunds)
		.where(
			and(eq(qrTabRefunds.tabId, tab.id), eq(qrTabRefunds.status, 'pending')),
		)
		.limit(1)
	if (pendingOnTab) {
		return bookFailure(
			409,
			'refund_pending',
			'A refund of this tab is already waiting on the payment provider.',
		)
	}
	const back = await tabPaymentRefunded(tx, tab.id, payment.tabPaymentId)
	const refundableCents = Math.max(
		0,
		payment.amountCents - back.succeeded - back.pending,
	)
	if (refundableCents === 0) {
		return bookFailure(
			409,
			'refund_complete',
			'This payment is already fully refunded.',
		)
	}
	// A tab's fee is part of what the guest paid: a full refund gives it back;
	// a partial one is the amount typed (no separate tick for tabs).
	if ('includeServiceFee' in input.amount && input.amount.includeServiceFee) {
		return bookFailure(
			422,
			'include_service_fee_unsupported',
			'Enter the amount to refund. A table tab has no separate service fee option.',
		)
	}
	const amountCents =
		'full' in input.amount ? refundableCents : input.amount.amountCents
	if (amountCents > refundableCents) {
		return bookFailure(
			422,
			'refund_exceeds_payment',
			'That is more than is left to refund.',
			{ refundableCents },
		)
	}
	const [refund] = await tx
		.insert(qrTabRefunds)
		.values({
			tabId: tab.id,
			tabPaymentId: payment.tabPaymentId,
			amountCents,
			currency: payment.currency,
			full: back.succeeded + amountCents >= payment.amountCents,
			note: input.note,
			actorId: input.actorId,
			origin: input.origin,
			status: 'pending',
			processor: payment.processor,
			sessionId: payment.sessionId,
			idempotencyKey: input.idempotencyKey,
			requestHash,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.returning()
	return { ok: true, refund: refund!, replayed: false }
}

const iso = (ms: number | null | undefined, fallback: number) =>
	new Date(ms ?? fallback).toISOString()

/** A provider refund of an order as the App needs it (ids and amounts only). */
export function orderProviderRefundView(
	refund: RestaurantOrderRefund,
	order: Pick<RestaurantOrder, 'paymentId'>,
): OrderProviderRefund {
	return {
		refundId: refund.id,
		orderId: refund.orderId,
		tabPaymentId: null,
		amountCents: refund.amountCents,
		currency: refund.currency,
		processor: (refund.processor ??
			'connect') as OrderProviderRefund['processor'],
		sessionId: refund.sessionId ?? '',
		paymentId: order.paymentId ?? null,
		// A refund the provider reversed after it succeeded reads failed.
		status: refund.reversedAt != null ? 'failed' : refund.status,
		providerRefundId: refund.providerRefundId ?? null,
		createdAt: iso(refund.createdAt, refund.createdAt),
		updatedAt: iso(refund.updatedAt, refund.createdAt),
	}
}

/**
 * A provider refund of tab money. `paymentId` is null: for `checkout` the
 * `sessionId` already is the Checkout.com payment id (the tab binds one
 * reference per tab and stores each payment's own id); for `connect` the App
 * resolves the PaymentIntent from the Checkout Session.
 */
export function tabProviderRefundView(
	refund: QrTabRefund,
): OrderProviderRefund {
	return {
		refundId: refund.id,
		orderId: tabOrderRef(refund.tabId),
		tabPaymentId: refund.tabPaymentId ?? null,
		amountCents: refund.amountCents,
		currency: refund.currency,
		processor: refund.processor,
		sessionId: refund.sessionId,
		paymentId: null,
		status: refund.reversedAt != null ? 'failed' : refund.status,
		providerRefundId: refund.providerRefundId ?? null,
		createdAt: iso(refund.createdAt, refund.createdAt),
		updatedAt: iso(refund.updatedAt, refund.createdAt),
	}
}
