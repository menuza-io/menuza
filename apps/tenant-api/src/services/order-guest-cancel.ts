import crypto from 'node:crypto'
import { and, eq, like, lte } from 'drizzle-orm'

import { getDropDisplayStatus, type DropStatus } from '@repo/common/menu-types'
import {
	guestCancelWindow,
	readGuestCancelPolicy,
	type GuestCancelPolicy,
	type GuestCancelRefusalReason,
	type GuestCancelResponse,
	type GuestCancelWindow,
	type RestaurantOrderContext,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	kdsTickets,
	loyaltyIdempotencyKeys,
	restaurantOrders,
	runTenantTransaction,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { kickOrderRefundExecute } from '../lib/order-refund-kick.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { orderRefundedNetCents } from './order-refund-book.ts'
import {
	applyOrderStatusPatchInTx,
	expireHoldsInTx,
	fetchOrderContext,
	orderFailure,
	orderWriteQueues,
	runExclusive,
	settleOrderWriteQueues,
	type CancelRefundOutcome,
	type OrderGuestCancelGlance,
	type OrderServiceFailure,
	type OrderServiceResult,
	type OrderTx,
} from './order-service.ts'

/**
 * The guest cancels their own order (#111): `GET /orders/:id/cancel` (may I,
 * and until when) and `POST /orders/:id/cancel`. The caller has already
 * proved the receipt or order-link capability (`authorizeGuestOrder`).
 *
 * The policy is read from the CURRENT order context of the order's location
 * (`guestCancel`, only present while `ordering.guest_cancel` is on and the
 * location offers a window), so switching it off stops cancels at once. The
 * one rule is `guestCancelWindow` in `@repo/common`, the same check the App
 * and Sites use. The cancel itself is the operator cancel's own write
 * (`applyOrderStatusPatchInTx`): discount uses released, loyalty and
 * inventory settled, the `cancelled` guest message queued, and for a paid
 * online order a full provider refund booked in the same transaction and
 * handed to the App with the ids-only kick after commit.
 */

/** What a guest cancel answers with and why it was refused. */
export const GUEST_CANCEL_ERROR_CODES: Record<
	GuestCancelRefusalReason,
	string
> = {
	disabled: 'guest_cancel_disabled',
	not_cancellable: 'not_cancellable',
	cancel_window_closed: 'cancel_window_closed',
	order_in_preparation: 'order_in_preparation',
}

const REFUSAL_MESSAGES: Record<GuestCancelRefusalReason, string> = {
	disabled: 'This restaurant does not take cancellations online.',
	not_cancellable: 'This order cannot be cancelled online.',
	cancel_window_closed: 'The time to cancel this order has passed.',
	order_in_preparation: 'The kitchen has started this order.',
}

/** How long a guest cancel's answer is kept for a repeat with the same key. */
export const GUEST_CANCEL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

/**
 * The stored answers reuse the generic `loyalty_idempotency_keys` table
 * (scope, key, request hash, status, answer, expiry) under their own scope,
 * like the order limits reuse `loyalty_rate_counters`: no new table. The
 * answer holds no personal data (`guestCancelResponseSchema`), the key is
 * stored only as a SHA-256, and `member_id` stays null. Expired rows are
 * pruned here and by the loyalty tick.
 */
const IDEMPOTENCY_SCOPE_PREFIX = 'order_guest_cancel:'

function idempotencyScope(orderId: string): string {
	return `${IDEMPOTENCY_SCOPE_PREFIX}${orderId}`
}

function sha256Hex(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// Inputs of the window: policy, drop cutoff, kitchen progress
// ---------------------------------------------------------------------------

/** What the order context says about one order's cancel window. */
type CancelContext = {
	policy: GuestCancelPolicy | null
	/** The order's drop as the context has it; null when none came back. */
	drop: { slug: string; status: string; ordersCloseAt: string | null } | null
}

function cancelContextOf(context: RestaurantOrderContext, locationId: string) {
	const drop = context.drop?.drop
	return {
		policy: readGuestCancelPolicy(
			(context as { guestCancel?: unknown }).guestCancel,
			locationId,
		),
		drop: drop
			? {
					slug: drop.slug,
					status: drop.status,
					ordersCloseAt: drop.ordersCloseAt ?? null,
				}
			: null,
	} satisfies CancelContext
}

/**
 * The drop's ordering cutoff for a drop order. Fails closed: a drop the
 * context no longer has (deleted, back to draft) or one whose orders are
 * closed ends the window now at the latest.
 */
function dropCutoffAt(
	order: RestaurantOrder,
	context: CancelContext,
	now: Date,
): Date | null {
	if (!order.dropSlug) return null
	const drop = context.drop
	if (!drop || drop.slug.toLowerCase() !== order.dropSlug.toLowerCase()) {
		return now
	}
	const closeAt = drop.ordersCloseAt ? new Date(drop.ordersCloseAt) : null
	const cutoff = closeAt && Number.isFinite(closeAt.getTime()) ? closeAt : null
	const display = getDropDisplayStatus(
		drop.status as DropStatus,
		null,
		drop.ordersCloseAt,
		now,
	)
	if (display === 'closed' || display === 'draft') {
		return cutoff && cutoff < now ? cutoff : now
	}
	return cutoff
}

/**
 * Whether the kitchen has started the order: its online ticket has a dish
 * past New (preparing or ready, or one already served from the pass), or the
 * ticket was cleared.
 */
export async function orderKitchenStarted(
	db: OrderTx | Awaited<ReturnType<typeof getTenantDb>>,
	orderId: string,
): Promise<boolean> {
	const [ticket] = await db
		.select({
			progress: kdsTickets.progress,
			completedAt: kdsTickets.completedAt,
		})
		.from(kdsTickets)
		.where(
			and(eq(kdsTickets.source, 'online'), eq(kdsTickets.orderId, orderId)),
		)
		.limit(1)
	if (!ticket) return false
	if (ticket.completedAt != null) return true
	return Object.entries(ticket.progress ?? {}).some(
		([key, value]) =>
			key.startsWith('served:') ||
			(typeof value === 'string' && value !== 'new'),
	)
}

function windowFor(
	order: RestaurantOrder,
	context: CancelContext,
	kitchenStarted: boolean,
	now: Date,
): GuestCancelWindow {
	return guestCancelWindow({
		status: order.status,
		paymentMethod: order.paymentMethod,
		paymentStatus: order.paymentStatus,
		fulfillment: order.fulfillment,
		source: order.source ?? null,
		tabId: order.tabId ?? null,
		// An order without a creation time cannot be proven inside its window.
		placedAt: order.createdAt ?? new Date(0),
		paidAt: order.paidAt ?? null,
		scheduledFor: order.scheduledFor ?? null,
		dropCutoffAt: dropCutoffAt(order, context, now),
		policy: context.policy,
		kitchenStarted,
		now,
	})
}

/** The widest window any location could offer (10 minutes, lead 0). */
const WIDEST_POLICY: GuestCancelPolicy = {
	minutes: 10,
	scheduledLeadMinutes: 0,
}

/**
 * Whether the order could still be cancelled under the widest policy, without
 * asking the App: false for every order past any possible window (most reads
 * of the receipt), so only young orders cost an order-context fetch.
 */
function mightBeCancellable(order: RestaurantOrder, now: Date): boolean {
	return windowFor(order, { policy: WIDEST_POLICY, drop: null }, false, now)
		.allowed
}

async function freshCancelContext(
	orgId: string,
	order: RestaurantOrder,
): Promise<OrderServiceResult<CancelContext>> {
	const context = await fetchOrderContext(
		orgId,
		order.locationId,
		order.dropSlug ?? null,
	)
	if (!context.ok) return context
	return { ok: true, data: cancelContextOf(context.data, order.locationId) }
}

// A short cache for the receipt view only (the success page polls the
// receipt). `GET` and `POST /orders/:id/cancel` always read a fresh context.
const VIEW_CONTEXT_TTL_MS = 30_000
const VIEW_CONTEXT_MAX_ENTRIES = 500
const viewContextCache = new Map<
	string,
	{ value: CancelContext; expiresAt: number }
>()

async function cachedCancelContext(
	orgId: string,
	order: RestaurantOrder,
	now: number,
): Promise<CancelContext | null> {
	const key = `${orgId}\u0000${order.locationId}\u0000${order.dropSlug ?? ''}`
	const hit = viewContextCache.get(key)
	if (hit && hit.expiresAt > now) return hit.value
	const fresh = await freshCancelContext(orgId, order)
	if (!fresh.ok) return null
	if (viewContextCache.size >= VIEW_CONTEXT_MAX_ENTRIES)
		viewContextCache.clear()
	viewContextCache.set(key, {
		value: fresh.data,
		expiresAt: now + VIEW_CONTEXT_TTL_MS,
	})
	return fresh.data
}

/** Tests: forget cached order contexts of the receipt view. */
export function clearGuestCancelViewCacheForTest(): void {
	viewContextCache.clear()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `cancel` of the guest's receipt views (`receiptOrder`, `linkReceiptOrder`). */
export type GuestCancelGlance = OrderGuestCancelGlance

const NOT_CANCELLABLE: GuestCancelGlance = { allowed: false, until: null }

/**
 * Whether the receipt should offer "Cancel order", and until when. Never
 * throws and never fails the receipt: anything it cannot read is "no". The
 * order context may be up to 30 seconds old here; the cancel itself always
 * checks a fresh one.
 */
export async function guestCancelGlance(
	orgId: string,
	order: RestaurantOrder,
	now: Date = new Date(),
): Promise<GuestCancelGlance> {
	try {
		if (!mightBeCancellable(order, now)) return NOT_CANCELLABLE
		const context = await cachedCancelContext(orgId, order, now.getTime())
		if (!context) return NOT_CANCELLABLE
		const db = await getTenantDb(orgId)
		const window = windowFor(
			order,
			context,
			await orderKitchenStarted(db, order.id),
			now,
		)
		return window.allowed
			? { allowed: true, until: window.until?.toISOString() ?? null }
			: NOT_CANCELLABLE
	} catch (error) {
		console.warn(
			'Guest cancel state not read',
			orgId,
			order.id,
			error instanceof Error ? error.name : 'unknown',
		)
		return NOT_CANCELLABLE
	}
}

function windowResponse(window: GuestCancelWindow): GuestCancelResponse {
	return {
		allowed: window.allowed,
		until: window.until ? window.until.toISOString() : null,
		reason: window.reason,
	}
}

/** `GET /orders/:id/cancel`: may the guest cancel now, until when, and why not. */
export async function readGuestCancel(
	orgId: string,
	order: RestaurantOrder,
	now: Date = new Date(),
): Promise<OrderServiceResult<GuestCancelResponse>> {
	const context = await freshCancelContext(orgId, order)
	if (!context.ok) return context
	const db = await getTenantDb(orgId)
	const window = windowFor(
		order,
		context.data,
		await orderKitchenStarted(db, order.id),
		now,
	)
	return { ok: true, data: windowResponse(window) }
}

// ---------------------------------------------------------------------------
// The cancel
// ---------------------------------------------------------------------------

export type GuestCancelFailure = OrderServiceFailure & {
	/** The window as it stands (refusals of the rule only). */
	window?: GuestCancelResponse
}

export type GuestCancelResult =
	| { ok: true; data: GuestCancelResponse; replayed: boolean }
	| { ok: false; failure: GuestCancelFailure }

function refusal(window: GuestCancelWindow): GuestCancelResult {
	const reason = window.reason ?? 'not_cancellable'
	return {
		ok: false,
		failure: {
			status: 409,
			code: GUEST_CANCEL_ERROR_CODES[reason],
			message: REFUSAL_MESSAGES[reason],
			window: windowResponse(window),
		},
	}
}

/** What the guest is told about the money after the cancel. */
function refundAnswer(
	order: RestaurantOrder,
	outcome: CancelRefundOutcome | null,
): NonNullable<GuestCancelResponse['refund']> {
	if (outcome?.refund) {
		return {
			status: outcome.refund.status,
			amountCents: outcome.refund.amountCents,
		}
	}
	// Another refund was still waiting: the rest follows once it is final, so
	// everything not yet back is on its way.
	if (outcome?.code === 'refund_pending' && outcome.owedCents > 0) {
		return { status: 'pending', amountCents: outcome.owedCents }
	}
	const back = orderRefundedNetCents(order)
	if (back > 0) {
		return { status: 'succeeded', amountCents: back }
	}
	return { status: 'none', amountCents: 0 }
}

/**
 * `POST /orders/:id/cancel`. One transaction under the order lock: a stored
 * answer for this `Idempotency-Key` is returned as it was (no second cancel,
 * no second refund); otherwise the window is checked again on the current
 * order and kitchen ticket, then the order is cancelled by the operator
 * cancel's own write, and the answer is stored for 24 hours. A refusal is not
 * stored, so a retry is checked again.
 */
export async function cancelOrderAsGuest(
	orgId: string,
	order: RestaurantOrder,
	input: { idempotencyKey: string; now?: Date },
): Promise<GuestCancelResult> {
	// The order's location and drop never change, so the policy can be read
	// before the lock (a network call); the order itself is read again inside.
	const context = await freshCancelContext(orgId, order)
	if (!context.ok) return context

	const db = await getTenantDb(orgId)
	const queues = orderWriteQueues()
	const scope = idempotencyScope(order.id)
	const keyHash = sha256Hex(input.idempotencyKey)
	const requestHash = sha256Hex(`order-guest-cancel:${orgId}:${order.id}`)
	let refundOutcome: CancelRefundOutcome | null = null

	const result: GuestCancelResult = await runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx): Promise<GuestCancelResult> => {
				refundOutcome = null
				const now = input.now ?? new Date()
				await expireHoldsInTx(tx, now, queues.loyalty)

				const [stored] = await tx
					.select()
					.from(loyaltyIdempotencyKeys)
					.where(
						and(
							eq(loyaltyIdempotencyKeys.scope, scope),
							eq(loyaltyIdempotencyKeys.key, keyHash),
						),
					)
					.limit(1)
				if (
					stored &&
					stored.expiresAt > now.getTime() &&
					stored.requestHash === requestHash
				) {
					return {
						ok: true,
						data: JSON.parse(stored.responseJson) as GuestCancelResponse,
						replayed: true,
					}
				}

				const [current] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, order.id),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (!current) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				const window = windowFor(
					current,
					context.data,
					await orderKitchenStarted(tx, current.id),
					now,
				)
				if (!window.allowed) return refusal(window)

				const applied = await applyOrderStatusPatchInTx(
					tx,
					current,
					{
						status: 'cancelled',
						cancelReason: 'guest_asked',
						// Only a paid online order has money to send back; a free
						// one (`not_required`) books nothing and the cancel stands.
						refund: current.paymentMethod === 'online' ? 'full' : 'none',
					},
					{
						cancel: {
							mayRefund: true,
							origin: 'guest',
							actorId: 'guest',
							cancelledBy: 'guest',
						},
						queues,
						now,
					},
				)
				if (!applied.result.ok) return applied.result
				refundOutcome = applied.refund
				const cancelled = applied.result.data
				const answer: GuestCancelResponse = {
					allowed: false,
					until: window.until ? window.until.toISOString() : null,
					reason: null,
					status: cancelled.status,
					refund: refundAnswer(cancelled, applied.refund),
				}
				const nowMs = now.getTime()
				await tx
					.delete(loyaltyIdempotencyKeys)
					.where(
						and(
							like(
								loyaltyIdempotencyKeys.scope,
								`${IDEMPOTENCY_SCOPE_PREFIX}%`,
							),
							lte(loyaltyIdempotencyKeys.expiresAt, nowMs),
						),
					)
				await tx
					.insert(loyaltyIdempotencyKeys)
					.values({
						scope,
						key: keyHash,
						requestHash,
						statusCode: 200,
						responseJson: JSON.stringify(answer),
						createdAt: nowMs,
						expiresAt: nowMs + GUEST_CANCEL_IDEMPOTENCY_TTL_MS,
					})
					.onConflictDoUpdate({
						target: [loyaltyIdempotencyKeys.scope, loyaltyIdempotencyKeys.key],
						set: {
							requestHash,
							statusCode: 200,
							responseJson: JSON.stringify(answer),
							createdAt: nowMs,
							expiresAt: nowMs + GUEST_CANCEL_IDEMPOTENCY_TTL_MS,
						},
					})
				return { ok: true, data: answer, replayed: false }
			}),
		),
	)
	await settleOrderWriteQueues(orgId, queues)
	const booked = refundOutcome as CancelRefundOutcome | null
	if (result.ok && !result.replayed && booked?.refund && !booked.replayed) {
		// The App executes the refund; ids only leave the region.
		kickOrderRefundExecute(orgId, [booked.refund.refundId])
	}
	return result
}
