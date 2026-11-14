import {
	orderMessages,
	type OrderMessageChannel,
	type OrderMessageKind,
	type RestaurantOrder,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm'
import { runInBackground } from '../lib/background.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	isOrdersEmailEnabled,
	isOrdersSmsEnabled,
} from '../lib/orders-switches.ts'

/**
 * Enqueue side of guest order messages (#79). Every helper here runs inside the
 * caller's order transaction and only inserts `order_messages` rows; sending is
 * `order-message-send.ts`, after the transaction commits (best effort) or from
 * the tick. A row holds no address, number or text: the contact is read from
 * the order when the message is sent.
 *
 * Rules:
 * - Only pickup and delivery orders placed online: never a table round, a tab,
 *   or a Station sale (those are `pos_orders` and never reach these helpers).
 * - Only when the order carries the guest messages policy it was placed with
 *   (`restaurant_orders.guest_messages`, null while `ordering.guest_messages`
 *   was off or unreadable), and only the kinds its switches allow.
 * - Only for an order that stands: paid online, free, or paid at handoff. An
 *   online order whose payment never arrived gets nothing.
 * - Email when the order has an address. A text only for `ready` (and a
 *   changed time), only when the guest opted in, the order has a phone and this
 *   is the US node. The KSA node never inserts a text row.
 * - At most one row per order, kind and channel (unique key; inserts that hit
 *   it do nothing), so a status that goes back and forth sends nothing again.
 *   The exception is `eta_changed`: its dedupe key is the order's
 *   `promised_version`, so every qualifying push-back gets its own row, and a
 *   newer one supersedes any older one still waiting (see
 *   `queueEtaChangedMessage`).
 * - A kill switch that is off records the row `dropped` at once, so switching
 *   it back on sends no backlog.
 */

export type OrderMessageTx = TenantTransaction | TenantDatabase

export type OrderMessageContext = {
	/** Epoch ms. */
	now: number
	/** Receives the ids of rows queued to send, for delivery after commit. */
	collect?: (ids: readonly string[]) => void
}

type OrderForMessages = Pick<
	RestaurantOrder,
	| 'id'
	| 'fulfillment'
	| 'tabId'
	| 'tableId'
	| 'paymentMethod'
	| 'paymentStatus'
	| 'status'
	| 'contactEmail'
	| 'contactPhone'
	| 'smsUpdatesOptIn'
	| 'guestMessages'
> & { promisedVersion?: number }

/** Kinds that may go out as a text as well as an email. */
const SMS_KINDS = new Set<OrderMessageKind>(['ready', 'eta_changed'])

/** Order statuses that send a status message, and which. */
const STATUS_MESSAGE_KIND: Partial<Record<string, OrderMessageKind>> = {
	ready: 'ready',
	// No order status means "out for delivery" yet; the kind is ready for one.
	out_for_delivery: 'out_for_delivery',
	cancelled: 'cancelled',
}

function nodeRegion(): 'us' | 'ksa' | null {
	try {
		return getNodeRegion()
	} catch {
		return null
	}
}

/** An online pickup or delivery order, not a table round or a tab. */
export function isMessageableOrder(order: OrderForMessages): boolean {
	return (
		order.fulfillment !== 'dine_in' &&
		!order.tabId &&
		!order.tableId &&
		order.guestMessages !== null &&
		order.guestMessages !== undefined
	)
}

/** Paid online, free, or paid at handoff: the order stands. */
function orderStands(order: OrderForMessages): boolean {
	return (
		order.paymentMethod === 'handoff' ||
		order.paymentStatus === 'paid' ||
		order.paymentStatus === 'not_required'
	)
}

function kindAllowed(order: OrderForMessages, kind: OrderMessageKind): boolean {
	const policy = order.guestMessages
	if (!policy) return false
	if (kind === 'receipt') return policy.receipt === true
	if (kind === 'ready') return policy.ready === true
	if (kind === 'cancelled') return policy.cancelled === true
	// Out for delivery, a changed time and (later) accepted have no switch.
	return true
}

/** The channels a message of this kind would use for this order. */
export function orderMessageChannels(
	order: OrderForMessages,
	kind: OrderMessageKind,
	region: 'us' | 'ksa' | null = nodeRegion(),
): OrderMessageChannel[] {
	const channels: OrderMessageChannel[] = []
	if (order.contactEmail) channels.push('email')
	if (
		SMS_KINDS.has(kind) &&
		order.smsUpdatesOptIn === true &&
		region === 'us' &&
		Boolean(order.contactPhone)
	) {
		channels.push('sms')
	}
	return channels
}

function switchOff(channel: OrderMessageChannel): string | null {
	try {
		if (channel === 'email') {
			return isOrdersEmailEnabled() ? null : 'email_disabled'
		}
		return isOrdersSmsEnabled() ? null : 'sms_disabled'
	} catch {
		return null
	}
}

/**
 * `last_error` while a sender holds the row's lease (claimed, mid-send). Every
 * outcome overwrites it; a sender that dies leaves it behind with a lease that
 * lapses, which no longer counts as in flight.
 */
export const ORDER_MESSAGE_SENDING = 'sending'
/** `last_error` of an `eta_changed` row replaced by a newer push-back. */
export const ORDER_MESSAGE_SUPERSEDED = 'superseded'

/** Dedupe key of an `eta_changed` row: the promised version it announces. */
export function etaDedupeKey(promisedVersion: number): string {
	return String(promisedVersion)
}

/**
 * Drops the older `eta_changed` rows of one order and channel that still wait
 * (queued and not mid-send), so a backlog never sends two updated times. A row
 * that a sender holds right now is left alone: the sender's own check drops it
 * if it has not sent yet, and the newer row waits for it (`order-message-send`).
 */
async function supersedeOlderEta(
	tx: OrderMessageTx,
	orderId: string,
	channel: OrderMessageChannel,
	dedupeKey: string,
	now: number,
): Promise<void> {
	await tx
		.update(orderMessages)
		.set({ status: 'dropped', lastError: ORDER_MESSAGE_SUPERSEDED })
		.where(
			and(
				eq(orderMessages.orderId, orderId),
				eq(orderMessages.kind, 'eta_changed'),
				eq(orderMessages.channel, channel),
				eq(orderMessages.status, 'queued'),
				ne(orderMessages.dedupeKey, dedupeKey),
				or(
					isNull(orderMessages.lastError),
					ne(orderMessages.lastError, ORDER_MESSAGE_SENDING),
					lte(orderMessages.nextAttemptAt, now),
				),
			),
		)
}

/**
 * Queues one message kind for an order (every channel it qualifies for).
 * Returns the ids of the rows queued to send. Never throws for anything but a
 * database error, which rolls the order write back like any other.
 */
export async function queueOrderMessage(
	tx: OrderMessageTx,
	order: OrderForMessages,
	kind: OrderMessageKind,
	ctx: OrderMessageContext,
): Promise<string[]> {
	let channels: OrderMessageChannel[]
	let dedupeKey = ''
	try {
		if (!isMessageableOrder(order) || !orderStands(order)) return []
		if (!kindAllowed(order, kind)) return []
		if (kind === 'eta_changed') {
			if (typeof order.promisedVersion !== 'number') return []
			dedupeKey = etaDedupeKey(order.promisedVersion)
		}
		channels = orderMessageChannels(order, kind)
	} catch {
		return []
	}
	const queued: string[] = []
	for (const channel of channels) {
		const dropped = switchOff(channel)
		if (kind === 'eta_changed') {
			await supersedeOlderEta(tx, order.id, channel, dedupeKey, ctx.now)
		}
		const rows = await tx
			.insert(orderMessages)
			.values({
				orderId: order.id,
				kind,
				channel,
				dedupeKey,
				status: dropped ? 'dropped' : 'queued',
				attempts: 0,
				nextAttemptAt: ctx.now,
				lastError: dropped,
				createdAt: ctx.now,
			})
			.onConflictDoNothing({
				target: [
					orderMessages.orderId,
					orderMessages.kind,
					orderMessages.channel,
					orderMessages.dedupeKey,
				],
			})
			.returning({ id: orderMessages.id })
		if (rows[0] && !dropped) queued.push(rows[0].id)
	}
	if (queued.length > 0) {
		try {
			ctx.collect?.(queued)
		} catch {
			// Collecting is best effort; the tick sends what is left.
		}
	}
	return queued
}

/**
 * At placement: the receipt for an order that stands already (paid at
 * handoff, or free). An online order waits for its paid event.
 */
export async function queueOrderPlacedMessages(
	tx: OrderMessageTx,
	order: OrderForMessages,
	ctx: OrderMessageContext,
): Promise<string[]> {
	if (
		order.paymentMethod === 'online' &&
		order.paymentStatus !== 'not_required'
	) {
		return []
	}
	return queueOrderMessage(tx, order, 'receipt', ctx)
}

/** When an online order's payment arrives (`order` is the paid row). */
export async function queueOrderPaidMessages(
	tx: OrderMessageTx,
	order: OrderForMessages,
	ctx: OrderMessageContext,
): Promise<string[]> {
	if (order.paymentStatus !== 'paid') return []
	return queueOrderMessage(tx, order, 'receipt', ctx)
}

/**
 * After a status change (`order` is the row as written). Ready, out for
 * delivery and cancelled send their message; an order released from payment
 * review (it was paid after its hold lapsed) also gets its receipt now. A
 * status that did not change sends nothing.
 */
export async function queueOrderStatusMessages(
	tx: OrderMessageTx,
	order: OrderForMessages,
	prevStatus: RestaurantOrder['status'] | null,
	nextStatus: RestaurantOrder['status'] | null,
	ctx: OrderMessageContext,
): Promise<string[]> {
	if (!nextStatus || prevStatus === nextStatus) return []
	const queued: string[] = []
	if (prevStatus === 'payment_review' && nextStatus !== 'cancelled') {
		queued.push(...(await queueOrderMessage(tx, order, 'receipt', ctx)))
	}
	const kind = STATUS_MESSAGE_KIND[nextStatus]
	if (kind) queued.push(...(await queueOrderMessage(tx, order, kind, ctx)))
	return queued
}

/**
 * A changed ready or arrival time (#109): `applyPromisedDelay` calls it for
 * every push-back of 10 minutes or more, with `promised_at` / `promised_until`
 * and the new `promised_version` already written on `order`. Each version gets
 * its own row per channel (the 90-minute cap bounds how many); queueing it
 * drops older ones still waiting, and the sender renders the time from the
 * order as it is when it sends, so the guest only ever hears the newest time.
 */
export async function queueEtaChangedMessage(
	tx: OrderMessageTx,
	order: OrderForMessages & { promisedVersion: number },
	ctx: OrderMessageContext,
): Promise<string[]> {
	if (order.status === 'cancelled' || order.status === 'completed') return []
	return queueOrderMessage(tx, order, 'eta_changed', ctx)
}

const inFlight = new Set<Promise<void>>()

/** Resolves once every after-commit send has finished (tests). */
export async function orderMessagesIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}

/**
 * Collects what an order write queued and sends it after the write commits.
 * `context()` goes to the queue helpers inside the transaction; `deliver()`
 * starts the send in the background after commit (kept alive with the
 * platform's `waitUntil`) and never throws or delays the response: the tick
 * retries whatever is left.
 */
export function orderMessageBatch() {
	const ids = new Set<string>()
	return {
		context(now: number = Date.now()): OrderMessageContext {
			return {
				now,
				collect: (queued) => {
					for (const id of queued) ids.add(id)
				},
			}
		},
		deliver(orgId: string): void {
			if (ids.size === 0) return
			const pending = [...ids]
			ids.clear()
			const work = (async () => {
				try {
					const { deliverOrderMessagesByIds } =
						await import('./order-message-send.ts')
					await deliverOrderMessagesByIds(orgId, pending)
				} catch (error) {
					console.warn(
						'Order messages not sent after commit',
						orgId,
						error instanceof Error ? error.name : 'unknown',
					)
				}
			})().finally(() => {
				inFlight.delete(work)
			})
			inFlight.add(work)
			runInBackground(work)
		},
	}
}

export type OrderMessageBatch = ReturnType<typeof orderMessageBatch>
