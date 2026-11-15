import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type OrderRejectReason } from '@repo/common/restaurant-orders'
import { z } from 'zod'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'

type Translate = (descriptor: MessageDescriptor) => string

export type OrderDecision =
	{ kind: 'accept' } | { kind: 'reject'; reason: OrderRejectReason }

type OrdersRequest = (
	path: string,
	init?: { method?: string; body?: string; signal?: AbortSignal },
) => Promise<unknown>

/**
 * Accepts or rejects a waiting order: the browser PATCHes the region with the
 * orders token. Rejecting a paid online order refunds it in full there.
 */
export function decideOrder(
	request: OrdersRequest,
	orderId: string,
	decision: OrderDecision,
): Promise<unknown> {
	return request(`/${encodeURIComponent(orderId)}`, {
		method: 'PATCH',
		body: JSON.stringify(
			decision.kind === 'accept'
				? { status: 'accepted' }
				: { status: 'cancelled', rejectReason: decision.reason },
		),
	})
}

/** True when someone else already decided the order, or it timed out. */
export function isAlreadyDecided(error: unknown): boolean {
	return (
		error instanceof OperatorRequestError &&
		(error.code === 'order_not_pending' || error.code === 'stale_version')
	)
}

export function decisionErrorMessage(
	error: unknown,
	translate: Translate,
): string {
	if (isAlreadyDecided(error)) {
		return translate(
			msg`This order was already decided or it timed out. The list is updated.`,
		)
	}
	if (error instanceof OperatorRequestError) {
		if (error.code === 'refund_forbidden') {
			return translate(
				msg`Rejecting a paid order refunds it, which is not available while impersonating.`,
			)
		}
		if (error.code === 'reject_reason_required') {
			return translate(msg`Choose why the order is rejected.`)
		}
	}
	return translate(msg`Unable to update this order. Refresh and try again.`)
}

/** What happened to the refund that rejecting a paid order starts. */
export function rejectNotice(response: unknown, translate: Translate): string {
	const parsed = z
		.object({
			refundIntent: z.unknown().nullable().optional(),
			refundError: z.string().nullable().optional(),
		})
		.safeParse(response)
	if (!parsed.success) return translate(msg`Order rejected.`)
	const { refundIntent, refundError } = parsed.data
	if (refundIntent) {
		return translate(
			msg`Order rejected. Refund pending: it is being sent to the guest's card.`,
		)
	}
	if (refundError) {
		return translate(
			msg`Order rejected, but the refund could not be started. Refund it from this order.`,
		)
	}
	return translate(msg`Order rejected.`)
}

/** Seconds from `now` to the deadline (negative once past); null if none. */
export function secondsUntil(
	deadline: string | null | undefined,
	now: number,
): number | null {
	if (!deadline) return null
	const time = Date.parse(deadline)
	if (Number.isNaN(time)) return null
	return Math.ceil((time - now) / 1000)
}

/** `3:12` style clock for a number of seconds (never negative). */
export function formatClock(seconds: number): string {
	const safe = Math.max(0, seconds)
	const m = Math.floor(safe / 60)
	const s = safe % 60
	return `${m}:${String(s).padStart(2, '0')}`
}

/** A rejected order, including one nobody accepted in time. */
export function isRejectedOrder(order: {
	status: string
	rejectedReason?: string | null
	cancelReason?: string | null
	cancelledBy?: string | null
}): boolean {
	if (order.status !== 'cancelled') return false
	return (
		Boolean(order.rejectedReason) ||
		(order.cancelledBy === 'system' &&
			order.cancelReason === 'not_accepted_in_time')
	)
}
