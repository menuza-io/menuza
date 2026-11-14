/**
 * Guest self-cancel and order-acceptance views for the order page (#111,
 * #107). Pure helpers so the rules are unit-testable without a browser. The
 * region decides everything; the page only shows what `GET /orders/:id`
 * says and counts down to `cancel.until`.
 */

export type GuestCancelOrder = {
	status: string
	paymentStatus?: string
	cancel?: { allowed: boolean; until: string | null } | null
	rejected?: boolean
	cancelReason?: string | null
	refundStatus?: string
	refundPendingCents?: number
	refundedCents?: number
}

/** Guest-visible cancel reasons; anything else is internal and never shown. */
const VISIBLE_REASONS = new Set(['out_of_stock', 'kitchen_closed'])

/**
 * The cancel window to offer: the end instant in ms, or null when the button
 * must stay hidden (no `cancel` block, not allowed, no end, time up, or the
 * order is already settled).
 */
export function cancelWindowEnd(
	order: GuestCancelOrder,
	nowMs: number,
): number | null {
	if (!order.cancel?.allowed || !order.cancel.until) return null
	if (order.status === 'cancelled' || order.status === 'expired') return null
	const until = Date.parse(order.cancel.until)
	if (Number.isNaN(until) || until <= nowMs) return null
	return until
}

/** Whether the order was paid online, so a cancel means a refund. */
export function paidOnline(order: Pick<GuestCancelOrder, 'paymentStatus'>) {
	return order.paymentStatus === 'paid'
}

function unitText(
	value: number,
	unit: 'minute' | 'second',
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'unit',
			unit,
			unitDisplay: 'long',
		}).format(value)
	} catch {
		return `${value} ${unit}`
	}
}

/**
 * "2 minutes" while there is more than a minute (rounded up), "45 seconds"
 * in the last minute. Digits and unit words follow the page locale.
 */
export function formatCancelRemaining(
	remainingMs: number,
	locale: string = 'en',
): string {
	const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000)
	if (totalSeconds > 60) {
		return unitText(Math.ceil(totalSeconds / 60), 'minute', locale)
	}
	return unitText(Math.max(1, totalSeconds), 'second', locale)
}

/** Whole minutes (rounded up) for throttled screen reader announcements. */
export function cancelAnnounceKey(remainingMs: number): number {
	const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000)
	return totalSeconds > 60 ? Math.ceil(totalSeconds / 60) : 0
}

export type OrderStage = 'waiting' | 'rejected' | 'cancelled' | 'normal'

/** Where the order stands in the restaurant's acceptance step. */
export function orderStage(order: GuestCancelOrder): OrderStage {
	if (order.status === 'pending_acceptance') return 'waiting'
	if (order.status === 'cancelled') {
		return order.rejected === true ? 'rejected' : 'cancelled'
	}
	return 'normal'
}

/** The reason to show the guest, or null (internal reasons are never shown). */
export function visibleCancelReason(order: GuestCancelOrder): string | null {
	const reason = order.cancelReason
	return reason && VISIBLE_REASONS.has(reason) ? reason : null
}

export type RefundView =
	| { kind: 'none' }
	| { kind: 'pending'; amountCents: number }
	| { kind: 'refunded'; amountCents: number }
	| { kind: 'failed' }

/** What to tell the guest about their money on a cancelled order. */
export function refundView(order: GuestCancelOrder): RefundView {
	const refunded = Number.isFinite(order.refundedCents)
		? (order.refundedCents ?? 0)
		: 0
	if (order.refundStatus === 'pending') {
		const pending = order.refundPendingCents ?? 0
		return { kind: 'pending', amountCents: pending > 0 ? pending : 0 }
	}
	if (order.refundStatus === 'failed') return { kind: 'failed' }
	if (refunded > 0) return { kind: 'refunded', amountCents: refunded }
	return { kind: 'none' }
}

/** The text for a refused cancel (409 code), as a label key. */
export type CancelRefusalKey = 'closed' | 'preparing' | 'unavailable'

export function cancelRefusalKey(code: string): CancelRefusalKey {
	if (code === 'cancel_window_closed') return 'closed'
	if (code === 'order_in_preparation') return 'preparing'
	return 'unavailable'
}

/**
 * One idempotency key per confirm tap, reused while a network failure leaves
 * the outcome unknown, dropped once the region has answered.
 */
export function createCancelAttempt(makeKey: () => string) {
	let key: string | null = null
	return {
		/** The key for this confirm tap (the same one on a retry). */
		current(): string {
			key ??= makeKey()
			return key
		},
		/** The region answered (success or refusal): the next tap is new. */
		settle(): void {
			key = null
		},
	}
}
