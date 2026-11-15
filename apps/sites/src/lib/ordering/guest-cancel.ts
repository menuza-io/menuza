/**
 * Guest self-cancel and order-acceptance views for the order page (#111,
 * #107). Pure helpers so the rules are unit-testable without a browser. The
 * region decides everything; the page only shows what `GET /orders/:id`
 * says and counts down to `cancel.until`.
 */

export type GuestCancelOrder = {
	status: string
	paymentStatus?: string
	/** `online` or `handoff`, when the region says (the receipt may omit it). */
	paymentMethod?: string
	/**
	 * The region's own answer: a cancel refunds a card payment. Wins over
	 * everything else when present.
	 */
	refundsOnCancel?: boolean
	/** The region's clock when it answered (ISO text or epoch ms), when it says. */
	serverNow?: string | number | null
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
 * How far this device's clock is ahead of the region's (server minus local,
 * ms), from the region's `serverNow` read at `localNowMs`. 0 when the region
 * sent none or it cannot be read, so an older node behaves as before.
 */
export function clockOffsetMs(
	serverNow: string | number | null | undefined,
	localNowMs: number,
): number {
	const server =
		typeof serverNow === 'number'
			? serverNow
			: typeof serverNow === 'string'
				? Date.parse(serverNow)
				: Number.NaN
	if (!Number.isFinite(server)) return 0
	return server - localNowMs
}

/**
 * The cancel window to offer: the end instant in ms on THIS device's clock,
 * or null when the button must stay hidden (no `cancel` block, not allowed,
 * no end, time up, or the order is already settled). `cancel.until` is the
 * region's time, so it is judged against the region's now (`nowMs` plus
 * `offsetMs` from `clockOffsetMs`) and shifted back for the local countdown;
 * a phone with a fast clock keeps its button.
 */
export function cancelWindowEnd(
	order: GuestCancelOrder,
	nowMs: number,
	offsetMs = 0,
): number | null {
	if (!order.cancel?.allowed || !order.cancel.until) return null
	if (order.status === 'cancelled' || order.status === 'expired') return null
	const until = Date.parse(order.cancel.until)
	if (Number.isNaN(until) || until <= nowMs + offsetMs) return null
	return until - offsetMs
}

/**
 * Whether a cancel means a card refund, so the confirm box may promise one.
 * The region's `refundsOnCancel` decides when it sends it. Otherwise: a known
 * payment method must be online and paid. A receipt that carries neither
 * field (an older region) keeps the old reading, `paid`.
 */
export function paidOnline(
	order: Pick<
		GuestCancelOrder,
		'paymentStatus' | 'paymentMethod' | 'refundsOnCancel'
	>,
) {
	if (typeof order.refundsOnCancel === 'boolean') return order.refundsOnCancel
	if (typeof order.paymentMethod === 'string') {
		return order.paymentMethod === 'online' && order.paymentStatus === 'paid'
	}
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

/**
 * What to announce for the countdown, or null while it is the same minute as
 * the last announcement. `lastKey` is the previous `cancelAnnounceKey` (null
 * before the first one); the last minute (key 0) is announced once too.
 */
export function nextCancelAnnouncement(
	lastKey: number | null,
	remainingMs: number,
): { key: number; announce: boolean } {
	const key = cancelAnnounceKey(remainingMs)
	return { key, announce: key !== lastKey }
}

/**
 * Why the cancel box went away without the guest asking (a poll said no, or
 * time ran out), as a label key; null when the heading already explains it
 * (the order is cancelled or expired). `nowMs` plus `offsetMs` is the
 * region's now.
 */
export function cancelHiddenKey(
	order: GuestCancelOrder,
	nowMs: number,
	offsetMs = 0,
): CancelRefusalKey | null {
	if (order.status === 'cancelled' || order.status === 'expired') return null
	if (
		order.status === 'preparing' ||
		order.status === 'ready' ||
		order.status === 'completed'
	) {
		return 'preparing'
	}
	const until = order.cancel?.until
		? Date.parse(order.cancel.until)
		: Number.NaN
	if (Number.isFinite(until) && until <= nowMs + offsetMs) return 'closed'
	return 'unavailable'
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
