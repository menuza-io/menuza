import {
	onlineOrderIsNew,
	onlineOrderLate,
	type PosOnlineOrderSummary,
} from '@repo/common/pos-online-orders'
import { parseDecimal, toCents } from '~/lib/money.ts'

/** The inbox's columns, in the order the counter works them. */
export type InboxSection = 'new' | 'in_progress' | 'ready' | 'done'

export function inboxSection(order: PosOnlineOrderSummary): InboxSection {
	if (order.status === 'completed' || order.status === 'cancelled')
		return 'done'
	if (order.status === 'ready') return 'ready'
	if (onlineOrderIsNew(order)) return 'new'
	return 'in_progress'
}

export type OrderFilter = {
	section: InboxSection | 'all'
	fulfillment: 'all' | 'pickup' | 'delivery' | 'dine_in'
	/** Order number or guest name. */
	query: string
}

/** Sorted for the counter: late first, then by when it is promised (or came in). */
export function inboxOrders(
	orders: PosOnlineOrderSummary[],
	filter: OrderFilter,
	now: number,
): PosOnlineOrderSummary[] {
	const query = filter.query.trim().toLocaleLowerCase()
	const due = (order: PosOnlineOrderSummary) => order.dueAt ?? order.createdAt
	return orders
		.filter(
			(order) =>
				(filter.section === 'all'
					? inboxSection(order) !== 'done'
					: inboxSection(order) === filter.section) &&
				(filter.fulfillment === 'all' ||
					order.fulfillment === filter.fulfillment) &&
				(!query ||
					order.number.toLocaleLowerCase().includes(query) ||
					order.guestName.toLocaleLowerCase().includes(query)),
		)
		.sort((a, b) => {
			if (inboxSection(a) === 'done' && inboxSection(b) === 'done')
				return (
					(b.completedAt ?? b.cancelledAt ?? 0) -
					(a.completedAt ?? a.cancelledAt ?? 0)
				)
			const lateA = onlineOrderLate(a, now) ? 0 : 1
			const lateB = onlineOrderLate(b, now) ? 0 : 1
			return lateA - lateB || due(a) - due(b)
		})
}

export function sectionCounts(orders: PosOnlineOrderSummary[]) {
	const counts: Record<InboxSection, number> = {
		new: 0,
		in_progress: 0,
		ready: 0,
		done: 0,
	}
	for (const order of orders) counts[inboxSection(order)] += 1
	return counts
}

/** New orders nobody has opened on any Station here: the alert repeats while there are any. */
export function unopenedOrders(
	orders: PosOnlineOrderSummary[],
	/** Opened on this screen a moment ago, before the server's answer came back. */
	openedHere: ReadonlySet<string>,
): PosOnlineOrderSummary[] {
	return orders
		.filter((order) => onlineOrderIsNew(order) && !openedHere.has(order.id))
		.sort((a, b) => a.createdAt - b.createdAt)
}

/** How often the new-order sound repeats while an order waits to be opened. */
export const ALERT_REPEAT_MS = 10_000

/**
 * A refund amount typed at the counter, in cents, or null when it is not a
 * valid one. Arabic-Indic digits and the Arabic decimal separator are read
 * (`12٫50`); anything else is refused rather than stripped, so a stray
 * character can never turn 12.50 into 1250.
 */
export function refundCents(typed: string, refundableCents: number) {
	const normalized = typed.trim()
	const value = parseDecimal(normalized)
	if (value === null) return null
	// At most two decimals: 10.005 is not an amount of money.
	if (!/^[^.,\u066B]*([.,\u066B][^.,\u066B]{0,2})?$/.test(normalized))
		return null
	const cents = toCents(value)
	if (cents < 1 || cents > refundableCents) return null
	return cents
}

export { onlineOrderIsNew, onlineOrderLate }
