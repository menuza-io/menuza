import { type AlertSubject } from '@repo/common/operator-alert-copy'
import { type Order, WAITING_ORDER_STATUS } from './order-model.ts'

/**
 * The Orders page's new-order alert (#265): which orders are new, which still
 * need someone, and which have been dealt with. Pure: the hook
 * (`useNewOrderAlerts`) owns the timers, the sound and the notification. What it
 * holds is an order number, a type, a time, a total and a dish count; it never
 * reads the guest's name, phone, address, notes or items.
 */

/** Statuses of an order nobody has started: "New". */
export const NEW_ORDER_STATUSES: readonly string[] = [
	'accepted',
	WAITING_ORDER_STATUS,
]

/** The chime repeats this often until the order is opened or accepted. */
export const NEW_ORDER_REPEAT_MS = 30_000

/** A time this far ahead makes it a scheduled order (softer alert now, loud at its time). */
export const SCHEDULED_LEAD_MS = 2 * 60_000

export type OrderAlertItem = {
	orderId: string
	number: string
	/**
	 * `new`: needs someone now (repeats). `scheduled`: placed for later, told once
	 * and softly. `started`: a scheduled order whose time has come (repeats).
	 */
	kind: 'new' | 'scheduled' | 'started'
	/** The status it had when the alert began (acceptance by a person ends it). */
	startedStatus: string
	large: boolean
	startsAt: number | null
	subject: Extract<AlertSubject, { kind: 'orders_new' }>
}

export type AlertTracker = {
	primed: boolean
	seen: ReadonlySet<string>
	items: ReadonlyMap<string, OrderAlertItem>
}

export const EMPTY_TRACKER: AlertTracker = {
	primed: false,
	seen: new Set(),
	items: new Map(),
}

/** An online pickup or delivery order that is New (not a table round, not started). */
export function isNewOnlineOrder(order: Pick<Order, 'fulfillment' | 'status'>) {
	return (
		order.fulfillment !== 'dine_in' && NEW_ORDER_STATUSES.includes(order.status)
	)
}

function dishCount(order: Pick<Order, 'lines'>) {
	return order.lines.reduce(
		(total, line) =>
			total +
			(Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0),
		0,
	)
}

function scheduledMs(order: Pick<Order, 'scheduledFor'>): number | null {
	if (!order.scheduledFor) return null
	const ms = Date.parse(order.scheduledFor)
	return Number.isFinite(ms) ? ms : null
}

export function toAlertItem(
	order: Order,
	kind: OrderAlertItem['kind'],
): OrderAlertItem {
	const at = scheduledMs(order)
	return {
		orderId: order.id,
		number: order.number,
		kind,
		startedStatus: order.status,
		large: order.largeOrder === true,
		startsAt: at,
		subject: {
			kind: 'orders_new',
			orderNumber: order.number,
			fulfillment: order.fulfillment === 'delivery' ? 'delivery' : 'pickup',
			scheduledForMs: at,
			totalCents: order.totalCents,
			currency: order.currency,
			dishCount: dishCount(order),
			large: order.largeOrder === true,
		},
	}
}

export type TrackerStep = {
	next: AlertTracker
	/** Items that began this step (the hook makes a sound and may notify). */
	created: OrderAlertItem[]
}

/**
 * Moves the tracker to the latest list. The first list only primes it: orders
 * that were already there are not "new". After that, an order that appears New
 * starts an alert (softly, once, when it is for later); a scheduled order whose
 * time has come starts a loud one; an alert ends when its order is opened
 * (`dismissOrder`), accepted by a person, started, cancelled or gone.
 */
export function stepTracker(
	prev: AlertTracker,
	orders: readonly Order[],
	now: number,
): TrackerStep {
	const byId = new Map(orders.map((order) => [order.id, order]))
	const seen = new Set(prev.seen)
	const items = new Map<string, OrderAlertItem>()
	const created: OrderAlertItem[] = []

	if (!prev.primed) {
		for (const order of orders) seen.add(order.id)
		return { next: { primed: true, seen, items }, created }
	}

	for (const [id, item] of prev.items) {
		const order = byId.get(id)
		if (!order || !isNewOnlineOrder(order)) continue
		// A person accepting an order that waited for acceptance ends its alert.
		if (
			item.startedStatus === WAITING_ORDER_STATUS &&
			order.status !== WAITING_ORDER_STATUS
		) {
			continue
		}
		// A scheduled order's time has come: the loud alert starts now.
		if (
			item.kind === 'scheduled' &&
			item.startsAt !== null &&
			item.startsAt <= now
		) {
			const started = {
				...toAlertItem(order, 'started'),
				startsAt: item.startsAt,
			}
			items.set(id, started)
			created.push(started)
			continue
		}
		items.set(id, item)
	}

	for (const order of orders) {
		if (seen.has(order.id)) continue
		seen.add(order.id)
		if (!isNewOnlineOrder(order)) continue
		const at = scheduledMs(order)
		const forLater = at !== null && at - now > SCHEDULED_LEAD_MS
		const item = toAlertItem(order, forLater ? 'scheduled' : 'new')
		items.set(order.id, item)
		created.push(item)
	}
	return { next: { primed: true, seen, items }, created }
}

/** The order was opened: its alert ends. */
export function dismissOrder(
	prev: AlertTracker,
	orderId: string,
): AlertTracker {
	if (!prev.items.has(orderId)) return prev
	const items = new Map(prev.items)
	items.delete(orderId)
	return { ...prev, items }
}

/** Items that need someone now (they count in the tab title and repeat the sound). */
export function activeItems(tracker: AlertTracker): OrderAlertItem[] {
	return [...tracker.items.values()].filter((item) => item.kind !== 'scheduled')
}

/** `(2) Orders`: the count in front of the page title, never doubled. */
export function titleWithCount(title: string, count: number): string {
	const base = title.replace(/^\(\d+\)\s*/, '')
	return count > 0 ? `(${count}) ${base}` : base
}
