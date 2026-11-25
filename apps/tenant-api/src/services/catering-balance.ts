import crypto from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'

import {
	balanceOrderRef,
	dueAtForDate,
	type OperatorBalanceAction,
} from '@repo/common/catering'
import {
	cateringPayments,
	getTenantDb,
	restaurantOrders,
	runTenantTransaction,
	type CateringPayment,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { readBalanceToken } from '../lib/catering-tokens.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	onCateringBalancePaid,
	sendBalanceMessage,
} from './catering-messages.ts'
import {
	cateringBalanceCents,
	cateringBalanceOwedCents,
} from './catering-orders.ts'
import {
	derivePaymentToken,
	orderFailure,
	runExclusive,
	type OrderServiceResult,
} from './order-service.ts'

/**
 * The balance of a catering order (#361): the guest's pay-the-balance link and
 * its payment bridge (`bal:<orderId>`), and what an operator can do with an
 * unpaid balance (void it, reopen it, move its due date, send the link again).
 *
 * The deposit (or the whole total) is the order's own payment. The balance is
 * paid through its own hosted session, kept in `catering_payments`, one
 * pending session at a time. Whatever lands counts toward `paid_cents`, so a
 * refund can never ask for more than was paid. The guest's link is an HMAC of
 * the order id and `balance_version`: voiding, reopening or re-opening bumps
 * it and the old link stops working.
 */

type Scope = { locationIds: string[] | null; userId: string }

function inScope(scope: Scope, locationId: string) {
	return scope.locationIds === null || scope.locationIds.includes(locationId)
}

const NOT_FOUND = () => orderFailure(404, 'order_not_found', 'Order not found.')

const INVALID_TOKEN = () =>
	orderFailure(
		403,
		'invalid_balance_token',
		'This payment link is not valid. Ask the restaurant for a new one.',
	)

async function loadOrder(
	orgId: string,
	orderId: string,
): Promise<RestaurantOrder | null> {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, orderId))
		.limit(1)
	return row ?? null
}

/** Fully paid: nothing owed and not reopened. Such an order cannot be edited. */
export function isCateringFullyPaid(order: RestaurantOrder): boolean {
	return (
		order.isCatering &&
		order.paymentStatus === 'paid' &&
		(order.balanceState === 'paid' || order.balanceState === null)
	)
}

export function balanceStatusOf(
	order: RestaurantOrder,
	now: number,
): 'none' | 'awaiting_deposit' | 'due' | 'overdue' | 'paid' | 'void' {
	if (!order.isCatering || cateringBalanceCents(order) === 0) return 'none'
	if (order.paymentStatus !== 'paid') return 'awaiting_deposit'
	if (order.balanceState === 'void') return 'void'
	if (order.balanceState === 'paid') return 'paid'
	return order.balanceDueAt && order.balanceDueAt.getTime() <= now
		? 'overdue'
		: 'due'
}

// ---------------------------------------------------------------------------
// Operator views
// ---------------------------------------------------------------------------

export function operatorCateringOrderView(order: RestaurantOrder, now: number) {
	return {
		id: order.id,
		kind: 'order' as const,
		number: order.number,
		locationId: order.locationId,
		status: order.status,
		paymentStatus: order.paymentStatus,
		fulfillment: order.fulfillment,
		eventAt: order.cateringEventAt?.getTime() ?? null,
		guestCount: order.guestCount,
		notes: order.cateringNotes,
		quoteId: order.cateringQuoteId,
		contact: {
			name: order.contactName,
			phone: order.contactPhone,
			email: order.contactEmail,
		},
		currency: order.currency,
		subtotalCents: order.subtotalCents,
		taxCents: order.taxCents,
		deliveryFeeCents: order.deliveryFeeCents,
		totalCents: order.totalCents,
		lines: order.lines,
		paidCents:
			order.paidCents ??
			(order.paymentStatus === 'paid' ? order.totalCents : 0),
		refundedCents: order.refundedCents,
		depositPercent: order.depositPercent,
		depositCents: order.depositCents,
		balance: {
			status: balanceStatusOf(order, now),
			balanceCents: cateringBalanceCents(order),
			paidCents: order.balancePaidCents,
			owedCents: cateringBalanceOwedCents(order),
			dueAt: order.balanceDueAt?.getTime() ?? null,
			reminderSentAt: order.balanceBeforeDueSentAt?.getTime() ?? null,
			overdueSentAt: order.balanceOverdueSentAt?.getTime() ?? null,
		},
		fullyPaid: isCateringFullyPaid(order),
		createdAt: order.createdAt?.getTime() ?? null,
	}
}

export async function listCateringOrders(
	orgId: string,
	scope: Scope,
	now = Date.now(),
	limit = 200,
) {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.isCatering, true),
				// A pending checkout or an expired hold is not an order yet.
				inArray(restaurantOrders.paymentStatus, [
					'paid',
					'pending',
					'review',
					'not_required',
				]),
			),
		)
		.orderBy(desc(restaurantOrders.cateringEventAt))
		.limit(limit)
	return rows
		.filter(
			(row) =>
				inScope(scope, row.locationId) &&
				row.status !== 'expired' &&
				!(row.paymentStatus === 'pending' && row.status === 'cancelled'),
		)
		.map((row) => operatorCateringOrderView(row, now))
}

export async function getCateringOrder(
	orgId: string,
	orderId: string,
	scope: Scope,
	now = Date.now(),
): Promise<OrderServiceResult<ReturnType<typeof operatorCateringOrderView>>> {
	const order = await loadOrder(orgId, orderId)
	if (!order || !order.isCatering || !inScope(scope, order.locationId)) {
		return NOT_FOUND()
	}
	return { ok: true, data: operatorCateringOrderView(order, now) }
}

// ---------------------------------------------------------------------------
// Operator actions on the balance
// ---------------------------------------------------------------------------

export async function applyBalanceAction(input: {
	orgId: string
	orderId: string
	scope: Scope
	action: OperatorBalanceAction
	now?: Date
}): Promise<OrderServiceResult<ReturnType<typeof operatorCateringOrderView>>> {
	const { orgId, action } = input
	const now = input.now ?? new Date()
	const order = await loadOrder(orgId, input.orderId)
	if (!order || !order.isCatering || !inScope(input.scope, order.locationId)) {
		return NOT_FOUND()
	}
	if (order.status === 'cancelled' || order.status === 'expired') {
		return orderFailure(409, 'order_locked', 'This order was cancelled.')
	}
	if (order.paymentStatus !== 'paid') {
		return orderFailure(
			409,
			'balance_not_due',
			'The balance opens once the deposit is paid.',
		)
	}
	const db = await getTenantDb(orgId)
	const timeZone = order.locationTimezone ?? 'UTC'

	if (action.action === 'resend') {
		if (order.balanceState !== 'due' || cateringBalanceOwedCents(order) <= 0) {
			return orderFailure(409, 'balance_not_due', 'No balance is waiting.')
		}
		await sendBalanceMessage(orgId, order, 'balance_link')
		return { ok: true, data: operatorCateringOrderView(order, now.getTime()) }
	}

	const updated = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [fresh] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, order.id))
					.limit(1)
				if (!fresh) return NOT_FOUND()
				const owed = cateringBalanceOwedCents(fresh)
				if (action.action === 'void') {
					if (fresh.balanceState !== 'due' || owed <= 0) {
						return orderFailure(
							409,
							fresh.balanceState === 'void'
								? 'balance_voided'
								: 'balance_already_paid',
							'There is no unpaid balance to void.',
						)
					}
					// Any payment in progress is closed: the link is burned with the version.
					await tx
						.update(cateringPayments)
						.set({ status: 'expired', updatedAt: now.getTime() })
						.where(
							and(
								eq(cateringPayments.orderId, fresh.id),
								eq(cateringPayments.status, 'pending'),
							),
						)
					const [row] = await tx
						.update(restaurantOrders)
						.set({
							balanceState: 'void',
							balanceVersion: fresh.balanceVersion + 1,
							updatedAt: now,
						})
						.where(eq(restaurantOrders.id, fresh.id))
						.returning()
					return { ok: true as const, data: row! }
				}
				if (action.action === 'reopen') {
					if (fresh.balanceState !== 'void') {
						return orderFailure(
							409,
							'balance_not_due',
							'Only a voided balance can be reopened.',
						)
					}
					const [row] = await tx
						.update(restaurantOrders)
						.set({
							balanceState: 'due',
							balanceVersion: fresh.balanceVersion + 1,
							balanceBeforeDueSentAt: null,
							balanceOverdueSentAt: null,
							updatedAt: now,
						})
						.where(eq(restaurantOrders.id, fresh.id))
						.returning()
					return { ok: true as const, data: row! }
				}
				// set_due
				if (fresh.balanceState !== 'due') {
					return orderFailure(
						409,
						'balance_not_due',
						'The due date can only change while a balance is waiting.',
					)
				}
				const dueAt = dueAtForDate(action.dueDate, timeZone)
				const eventAt = fresh.cateringEventAt?.getTime() ?? null
				if (eventAt !== null && dueAt > eventAt + 86_400_000) {
					return orderFailure(
						422,
						'invalid_request',
						'The balance cannot be due after the event.',
					)
				}
				const [row] = await tx
					.update(restaurantOrders)
					.set({
						balanceDueAt: new Date(dueAt),
						// A new date gets its own reminders.
						balanceBeforeDueSentAt: null,
						balanceOverdueSentAt: null,
						updatedAt: now,
					})
					.where(eq(restaurantOrders.id, fresh.id))
					.returning()
				return { ok: true as const, data: row! }
			}),
		),
	)
	if (!updated.ok) return updated
	if (action.action === 'reopen') {
		// The guest gets the new link at once.
		void sendBalanceMessage(orgId, updated.data, 'balance_link')
	}
	return {
		ok: true,
		data: operatorCateringOrderView(updated.data, now.getTime()),
	}
}

/**
 * Event details of a catering order (time, head count, notes). A fully paid
 * order is locked: reopening a balance (an additional charge) is the way to
 * change what the guest paid for.
 */
export async function updateCateringEventDetails(input: {
	orgId: string
	orderId: string
	scope: Scope
	body: { guestCount?: number; notes?: string | null; eventAt?: string }
	now?: Date
}): Promise<OrderServiceResult<ReturnType<typeof operatorCateringOrderView>>> {
	const { orgId } = input
	const now = input.now ?? new Date()
	const order = await loadOrder(orgId, input.orderId)
	if (!order || !order.isCatering || !inScope(input.scope, order.locationId)) {
		return NOT_FOUND()
	}
	if (order.status === 'cancelled' || order.status === 'expired') {
		return orderFailure(409, 'order_locked', 'This order was cancelled.')
	}
	if (isCateringFullyPaid(order)) {
		return orderFailure(
			409,
			'order_locked',
			'This order is paid in full. Add a charge to reopen the balance before changing it.',
		)
	}
	const db = await getTenantDb(orgId)
	const [row] = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db
				.update(restaurantOrders)
				.set({
					guestCount: input.body.guestCount ?? order.guestCount,
					cateringNotes:
						input.body.notes === undefined
							? order.cateringNotes
							: input.body.notes,
					...(input.body.eventAt
						? {
								cateringEventAt: new Date(input.body.eventAt),
								scheduledFor: new Date(input.body.eventAt),
							}
						: {}),
					updatedAt: now,
				})
				.where(eq(restaurantOrders.id, order.id))
				.returning(),
		),
	)
	return { ok: true, data: operatorCateringOrderView(row!, now.getTime()) }
}

/**
 * Adds a charge to a paid order and reopens its balance for it (#361: a fully
 * paid order cannot be changed without reopening the balance). The charge is
 * a line without tax; the balance link is new and the guest is sent it.
 */
export async function addBalanceCharge(input: {
	orgId: string
	orderId: string
	scope: Scope
	label: string
	amountCents: number
	now?: Date
}): Promise<OrderServiceResult<ReturnType<typeof operatorCateringOrderView>>> {
	const { orgId } = input
	const now = input.now ?? new Date()
	const order = await loadOrder(orgId, input.orderId)
	if (!order || !order.isCatering || !inScope(input.scope, order.locationId)) {
		return NOT_FOUND()
	}
	if (order.paymentStatus !== 'paid' || order.status === 'cancelled') {
		return orderFailure(409, 'order_locked', 'This order cannot take a charge.')
	}
	const db = await getTenantDb(orgId)
	const lines = Array.isArray(order.lines) ? (order.lines as unknown[]) : []
	const extra = {
		itemId: `custom:${crypto.randomUUID()}`,
		itemName: input.label,
		variantId: null,
		quantity: 1,
		unitPriceCents: input.amountCents,
		taxableUnitCents: 0,
		totalCents: input.amountCents,
		taxableCents: 0,
		instructions: null,
		options: [],
		baseUnitCents: input.amountCents,
		categoryIds: [],
	}
	const timeZone = order.locationTimezone ?? 'UTC'
	const [row] = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db
				.update(restaurantOrders)
				.set({
					lines: [...lines, extra],
					subtotalCents: order.subtotalCents + input.amountCents,
					totalCents: order.totalCents + input.amountCents,
					balanceState: 'due',
					balanceVersion: order.balanceVersion + 1,
					balanceDueAt:
						order.balanceDueAt && order.balanceDueAt.getTime() > now.getTime()
							? order.balanceDueAt
							: new Date(dueAtForDate(addDaysIso(now, 3, timeZone), timeZone)),
					balanceBeforeDueSentAt: null,
					balanceOverdueSentAt: null,
					updatedAt: now,
				})
				.where(eq(restaurantOrders.id, order.id))
				.returning(),
		),
	)
	void sendBalanceMessage(orgId, row!, 'balance_link')
	return { ok: true, data: operatorCateringOrderView(row!, now.getTime()) }
}

function addDaysIso(now: Date, days: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(now.getTime() + days * 86_400_000))
	return parts
}

// ---------------------------------------------------------------------------
// The guest's balance link
// ---------------------------------------------------------------------------

async function orderForToken(
	orgId: string,
	orderId: string,
	token: string,
): Promise<
	| { ok: true; order: RestaurantOrder }
	| { ok: false; failure: ReturnType<typeof orderFailure> }
> {
	const parsed = readBalanceToken(orgId, token)
	if (!parsed || parsed.id !== orderId) {
		return { ok: false, failure: INVALID_TOKEN() }
	}
	const order = await loadOrder(orgId, orderId)
	if (!order || !order.isCatering || order.balanceVersion !== parsed.version) {
		return { ok: false, failure: INVALID_TOKEN() }
	}
	return { ok: true, order }
}

/** `GET /catering/balance/:orderId` with `X-Balance-Token`: what the guest sees. */
export async function getGuestBalance(input: {
	orgId: string
	orderId: string
	token: string
	now?: number
}): Promise<
	OrderServiceResult<{
		number: string
		status: ReturnType<typeof balanceStatusOf>
		payable: boolean
		eventAt: number | null
		guestCount: number | null
		currency: string
		totalCents: number
		paidCents: number
		owedCents: number
		dueAt: number | null
	}>
> {
	const now = input.now ?? Date.now()
	const checked = await orderForToken(input.orgId, input.orderId, input.token)
	if (!checked.ok) return checked.failure
	const { order } = checked
	const owed = cateringBalanceOwedCents(order)
	return {
		ok: true,
		data: {
			number: order.number,
			status: balanceStatusOf(order, now),
			payable:
				owed > 0 &&
				order.status !== 'cancelled' &&
				order.status !== 'expired' &&
				order.disputeStatus !== 'open',
			eventAt: order.cateringEventAt?.getTime() ?? null,
			guestCount: order.guestCount,
			currency: order.currency,
			totalCents: order.totalCents,
			paidCents:
				order.paidCents ??
				(order.paymentStatus === 'paid' ? order.totalCents : 0),
			owedCents: owed,
			dueAt: order.balanceDueAt?.getTime() ?? null,
		},
	}
}

export type BalanceStart = {
	orderRef: string
	paymentToken: string
	totalCents: number
	currency: string
}

/**
 * `POST /catering/balance/:orderId/pay` with `X-Balance-Token`: starts paying
 * the balance. One pending payment at a time (a second click reuses it).
 */
export async function startBalancePayment(input: {
	orgId: string
	orderId: string
	token: string
	now?: Date
}): Promise<OrderServiceResult<BalanceStart>> {
	const { orgId } = input
	const now = input.now ?? new Date()
	const checked = await orderForToken(orgId, input.orderId, input.token)
	if (!checked.ok) return checked.failure
	const db = await getTenantDb(orgId)
	const result = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, input.orderId))
					.limit(1)
				if (!order || order.balanceVersion !== checked.order.balanceVersion) {
					return INVALID_TOKEN()
				}
				const owed = cateringBalanceOwedCents(order)
				if (order.balanceState === 'void') {
					return orderFailure(
						409,
						'balance_voided',
						'This balance was cancelled.',
					)
				}
				if (order.balanceState === 'paid' || owed <= 0) {
					return orderFailure(
						409,
						'balance_already_paid',
						'This balance is already paid.',
					)
				}
				if (order.status === 'cancelled' || order.status === 'expired') {
					return orderFailure(409, 'order_locked', 'This order was cancelled.')
				}
				if (order.disputeStatus === 'open') {
					return orderFailure(
						409,
						'payment_disputed',
						'This order cannot take a payment right now.',
					)
				}
				const processor = order.paymentProcessor
				if (!processor) {
					return orderFailure(
						400,
						'online_payment_disabled',
						'Online payment is not available.',
					)
				}
				const [pending] = await tx
					.select()
					.from(cateringPayments)
					.where(
						and(
							eq(cateringPayments.orderId, order.id),
							eq(cateringPayments.status, 'pending'),
							eq(cateringPayments.balanceVersion, order.balanceVersion),
						),
					)
					.limit(1)
				if (pending && pending.amountCents !== owed) {
					await tx
						.update(cateringPayments)
						.set({ status: 'expired', updatedAt: now.getTime() })
						.where(eq(cateringPayments.id, pending.id))
				}
				if (!pending || pending.amountCents !== owed) {
					await tx.insert(cateringPayments).values({
						orderId: order.id,
						kind: 'balance',
						amountCents: owed,
						currency: order.currency,
						status: 'pending',
						processor,
						balanceVersion: order.balanceVersion,
						createdAt: now.getTime(),
						updatedAt: now.getTime(),
					})
				}
				const ref = balanceOrderRef(order.id)
				return {
					ok: true as const,
					data: {
						orderRef: ref,
						paymentToken: derivePaymentToken(orgId, ref),
						totalCents: owed,
						currency: order.currency,
					},
				}
			}),
		),
	)
	return result
}

// ---------------------------------------------------------------------------
// The `bal:<orderId>` payment bridge
// ---------------------------------------------------------------------------

async function pendingPayment(
	orgId: string,
	orderId: string,
): Promise<CateringPayment | null> {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(cateringPayments)
		.where(
			and(
				eq(cateringPayments.orderId, orderId),
				eq(cateringPayments.status, 'pending'),
			),
		)
		.orderBy(desc(cateringPayments.createdAt))
		.limit(1)
	return row ?? null
}

/** `POST /api/orders/quote` for `bal:<id>`: amounts and state only. */
export async function getBalanceQuote(
	orgId: string,
	orderId: string,
	paymentToken: string,
) {
	const ref = balanceOrderRef(orderId)
	const order = await loadOrder(orgId, orderId)
	if (!order || !order.isCatering) return NOT_FOUND()
	const expected = derivePaymentToken(orgId, ref)
	if (
		paymentToken.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(paymentToken), Buffer.from(expected))
	) {
		return orderFailure(
			403,
			'invalid_payment_token',
			'This payment link is not valid.',
		)
	}
	const payment = await pendingPayment(orgId, orderId)
	const owed = cateringBalanceOwedCents(order)
	const paid = owed <= 0 && order.balancePaidCents > 0
	return {
		ok: true as const,
		data: {
			orgId,
			orderId: ref,
			totalCents: payment?.amountCents ?? owed,
			currency: order.currency,
			holdExpiresAt: null,
			status:
				order.status === 'cancelled' || order.balanceState === 'void'
					? 'cancelled'
					: 'accepted',
			paymentStatus: paid ? 'paid' : payment ? 'pending' : 'unknown',
			...(payment?.sessionId && payment.processor
				? { sessionId: payment.sessionId, processor: payment.processor }
				: {}),
		},
	}
}

export async function bindBalancePaymentSession(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}) {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, input.orderId))
					.limit(1)
				if (!order || !order.isCatering) return NOT_FOUND()
				const [payment] = await tx
					.select()
					.from(cateringPayments)
					.where(
						and(
							eq(cateringPayments.orderId, order.id),
							eq(cateringPayments.status, 'pending'),
						),
					)
					.orderBy(desc(cateringPayments.createdAt))
					.limit(1)
				if (!payment) {
					return orderFailure(
						409,
						'balance_not_due',
						'There is no balance payment to start.',
					)
				}
				if (payment.sessionId && payment.sessionId !== input.sessionId) {
					return orderFailure(
						409,
						'session_conflict',
						'This payment already has a payment session.',
					)
				}
				if (payment.processor && payment.processor !== input.processor) {
					return orderFailure(
						409,
						'processor_mismatch',
						'This payment is bound to a different payment processor.',
					)
				}
				if (!payment.sessionId) {
					await tx
						.update(cateringPayments)
						.set({
							sessionId: input.sessionId,
							processor: input.processor,
							updatedAt: Date.now(),
						})
						.where(eq(cateringPayments.id, payment.id))
				}
				return {
					ok: true as const,
					data: {
						orgId,
						orderId: balanceOrderRef(order.id),
						sessionId: input.sessionId,
						status: order.status,
						paymentStatus: 'pending',
					},
				}
			}),
		),
	)
}

export async function applyBalancePaymentEvent(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	paymentId?: string
}) {
	const { orgId } = input
	const db = await getTenantDb(orgId)
	let becamePaid = false
	const result = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const now = Date.now()
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, input.orderId))
					.limit(1)
				if (!order || !order.isCatering) return NOT_FOUND()
				const [payment] = await tx
					.select()
					.from(cateringPayments)
					.where(eq(cateringPayments.sessionId, input.sessionId))
					.limit(1)
				if (!payment || payment.orderId !== order.id) {
					return orderFailure(
						403,
						'session_mismatch',
						'This payment event does not match a payment session.',
					)
				}
				const reply = (paymentStatus: string) => ({
					ok: true as const,
					data: {
						orgId,
						orderId: balanceOrderRef(order.id),
						sessionId: input.sessionId,
						status: order.status,
						paymentStatus,
					},
				})
				if (payment.status === 'paid' || payment.status === 'review') {
					return reply('paid')
				}
				if (payment.processor !== input.processor) {
					return orderFailure(
						409,
						'processor_mismatch',
						'This payment event does not match the bound payment processor.',
					)
				}
				if (payment.amountCents !== input.amountCents) {
					return orderFailure(
						422,
						'amount_mismatch',
						'The payment amount does not match this balance.',
					)
				}
				if (order.currency.toLowerCase() !== input.currency.toLowerCase()) {
					return orderFailure(
						422,
						'currency_mismatch',
						'The payment currency does not match this order.',
					)
				}
				if (input.status !== 'paid') {
					await tx
						.update(cateringPayments)
						.set({
							status: input.status === 'expired' ? 'expired' : 'failed',
							updatedAt: now,
						})
						.where(eq(cateringPayments.id, payment.id))
					return reply('failed')
				}
				// Money that landed always counts toward what was paid, so a refund can
				// never ask for more than was taken, even for a balance voided meanwhile.
				const stale =
					order.balanceState !== 'due' ||
					payment.balanceVersion !== order.balanceVersion
				await tx
					.update(cateringPayments)
					.set({
						status: stale ? 'review' : 'paid',
						paymentId: input.paymentId ?? payment.paymentId,
						paidAt: now,
						updatedAt: now,
					})
					.where(eq(cateringPayments.id, payment.id))
				const balancePaid = order.balancePaidCents + payment.amountCents
				const owedAfter = Math.max(
					0,
					order.totalCents -
						(order.depositCents ?? order.totalCents) -
						balancePaid,
				)
				await tx
					.update(restaurantOrders)
					.set({
						balancePaidCents: balancePaid,
						paidCents:
							(order.paidCents ?? order.depositCents ?? order.totalCents) +
							payment.amountCents,
						balanceState:
							owedAfter === 0 && !stale ? 'paid' : order.balanceState,
						updatedAt: new Date(now),
					})
					.where(eq(restaurantOrders.id, order.id))
				becamePaid = true
				return reply('paid')
			}),
		),
	)
	if (result.ok && becamePaid) {
		void onCateringBalancePaid(orgId, input.orderId)
	}
	return result
}
