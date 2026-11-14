import { z } from 'zod'

/**
 * Restaurant order lifecycle contracts shared by the App, the region, Sites
 * and Station: cancel and reject reasons (#80, #107), guest self-cancel
 * (#111) and manual order acceptance (#107). Pure, PII-free, no I/O.
 *
 * Kept out of `restaurant-orders.ts` (which re-exports everything here) so
 * that file does not grow further; import from
 * `@repo/common/restaurant-orders`.
 */

// ---------------------------------------------------------------------------
// Cancel and reject reasons
// ---------------------------------------------------------------------------

/** Reasons an operator picks when cancelling an order. */
export const ORDER_CANCEL_REASONS = [
	'out_of_stock',
	'kitchen_closed',
	'guest_asked',
	'duplicate',
	'other',
] as const
export type OrderCancelReason = (typeof ORDER_CANCEL_REASONS)[number]

/** Reasons an operator picks when rejecting an order waiting for acceptance. */
export const ORDER_REJECT_REASONS = [
	'out_of_stock',
	'kitchen_closed',
	'too_busy',
	'other',
] as const
export type OrderRejectReason = (typeof ORDER_REJECT_REASONS)[number]

/** Reasons only the system sets (the acceptance tick). */
export const ORDER_SYSTEM_CANCEL_REASONS = ['not_accepted_in_time'] as const
export type OrderSystemCancelReason =
	(typeof ORDER_SYSTEM_CANCEL_REASONS)[number]

/**
 * Every value `restaurant_orders.cancel_reason` (and `rejected_reason`) may
 * hold. A guest self-cancel stores `guest_asked` with `cancelled_by = guest`.
 */
export const ORDER_STORED_CANCEL_REASONS = [
	'out_of_stock',
	'kitchen_closed',
	'guest_asked',
	'duplicate',
	'too_busy',
	'other',
	'not_accepted_in_time',
] as const
export type OrderStoredCancelReason =
	(typeof ORDER_STORED_CANCEL_REASONS)[number]

/** Who cancelled an order (`restaurant_orders.cancelled_by`). */
export const ORDER_CANCELLED_BY_VALUES = [
	'operator',
	'guest',
	'system',
] as const
export type OrderCancelledBy = (typeof ORDER_CANCELLED_BY_VALUES)[number]

export const orderCancelReasonSchema = z.enum(ORDER_CANCEL_REASONS)
export const orderRejectReasonSchema = z.enum(ORDER_REJECT_REASONS)

/** Reasons the guest is told; everything else stays internal. */
export const GUEST_VISIBLE_CANCEL_REASONS = [
	'out_of_stock',
	'kitchen_closed',
] as const
export type GuestVisibleCancelReason =
	(typeof GUEST_VISIBLE_CANCEL_REASONS)[number]

/**
 * The reason a guest may see (receipt page, cancelled message): only
 * `out_of_stock` and `kitchen_closed`. Anything else, or nothing, is null.
 */
export function guestVisibleCancelReason(
	reason: string | null | undefined,
): GuestVisibleCancelReason | null {
	return reason === 'out_of_stock' || reason === 'kitchen_closed'
		? reason
		: null
}

/** Reads a stored reason; an unknown value reads as null. */
export function readStoredCancelReason(
	value: unknown,
): OrderStoredCancelReason | null {
	return typeof value === 'string' &&
		(ORDER_STORED_CANCEL_REASONS as readonly string[]).includes(value)
		? (value as OrderStoredCancelReason)
		: null
}

// ---------------------------------------------------------------------------
// Guest self-cancel (#111)
// ---------------------------------------------------------------------------

/** "Guests can cancel within": the minutes a location may offer. */
export const GUEST_CANCEL_MINUTES_CHOICES = [1, 2, 5, 10] as const
export type GuestCancelMinutes = (typeof GUEST_CANCEL_MINUTES_CHOICES)[number]

/** Largest "until N minutes before the scheduled time" a location may set. */
export const GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES = 24 * 60

/**
 * One location's guest-cancel policy as the order context carries it
 * (`guestCancel[locationId]`). Present only while `ordering.guest_cancel` is
 * on and the location offers a window. `scheduledLeadMinutes` null means
 * scheduled orders get the same window as ASAP ones.
 */
export const guestCancelPolicySchema = z.object({
	minutes: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)]),
	scheduledLeadMinutes: z
		.number()
		.int()
		.min(0)
		.max(GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES)
		.nullable(),
})
export type GuestCancelPolicy = z.infer<typeof guestCancelPolicySchema>

/** `guestCancel` of the order context: per location id, only those that offer it. */
export type GuestCancelContext = Record<string, GuestCancelPolicy>

/**
 * Reads one location's policy from the order context's `guestCancel`. Fails
 * closed: missing, malformed or unknown location is null (guests cannot
 * cancel).
 */
export function readGuestCancelPolicy(
	value: unknown,
	locationId: string,
): GuestCancelPolicy | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	if (!Object.prototype.hasOwnProperty.call(value, locationId)) return null
	const parsed = guestCancelPolicySchema.safeParse(
		(value as Record<string, unknown>)[locationId],
	)
	return parsed.success ? parsed.data : null
}

export const GUEST_CANCEL_REFUSAL_REASONS = [
	'disabled',
	'not_cancellable',
	'cancel_window_closed',
	'order_in_preparation',
] as const
export type GuestCancelRefusalReason =
	(typeof GUEST_CANCEL_REFUSAL_REASONS)[number]

export type GuestCancelWindowInput = {
	status: string
	paymentMethod: 'handoff' | 'online' | string
	paymentStatus: string
	fulfillment: 'pickup' | 'delivery' | 'dine_in' | string
	/** `restaurant_orders.source` (`qr_table` rounds are refused). */
	source?: string | null
	/** A QR tab round (always refused). */
	tabId?: string | null
	/** When the order was placed. */
	placedAt: Date
	/** When an online payment succeeded; the ASAP window starts then. */
	paidAt?: Date | null
	/** The guest's chosen time; null for ASAP. */
	scheduledFor?: Date | null
	/** A drop's ordering cutoff, when the order belongs to a drop. */
	dropCutoffAt?: Date | null
	/** The location's policy; null when off (flag off or no window). */
	policy: GuestCancelPolicy | null
	/** Any kitchen ticket for the order moved past New. */
	kitchenStarted: boolean
	now: Date
}

export type GuestCancelWindow = {
	allowed: boolean
	/** When the window closes (null when there is none). */
	until: Date | null
	reason: GuestCancelRefusalReason | null
}

const GUEST_CANCELLABLE_STATUSES = new Set(['accepted', 'pending_acceptance'])

/**
 * Whether a guest may cancel their own order now. The App (settings preview),
 * the region (`GET/POST /orders/:id/cancel`) and Sites (the countdown) use
 * this one check.
 *
 * - Off (no policy): `disabled`.
 * - QR table rounds, tab rounds and dine-in: `not_cancellable`.
 * - Status: only `accepted` or `pending_acceptance`; `preparing` reads as
 *   `order_in_preparation`, anything else `not_cancellable`.
 * - An online order must be paid (an unpaid one simply expires).
 * - A kitchen ticket past New: `order_in_preparation`.
 * - Window: ASAP orders from payment (online) or placement (handoff) for
 *   `minutes`; scheduled orders until `scheduledLeadMinutes` before the
 *   scheduled time, and never less than the ASAP window. A drop order also
 *   closes at the drop's cutoff. `now` equal to `until` is closed.
 */
export function guestCancelWindow(
	input: GuestCancelWindowInput,
): GuestCancelWindow {
	const refuse = (
		reason: GuestCancelRefusalReason,
		until: Date | null = null,
	): GuestCancelWindow => ({ allowed: false, until, reason })

	if (!input.policy || input.policy.minutes <= 0) return refuse('disabled')
	if (
		input.fulfillment === 'dine_in' ||
		input.tabId ||
		input.source === 'qr_table'
	) {
		return refuse('not_cancellable')
	}
	if (input.status === 'preparing') return refuse('order_in_preparation')
	if (!GUEST_CANCELLABLE_STATUSES.has(input.status)) {
		return refuse('not_cancellable')
	}
	if (
		input.paymentMethod === 'online' &&
		input.paymentStatus !== 'paid' &&
		input.paymentStatus !== 'not_required'
	) {
		return refuse('not_cancellable')
	}

	const start =
		input.paymentMethod === 'online' && input.paidAt
			? input.paidAt
			: input.placedAt
	let until = start.getTime() + input.policy.minutes * 60_000
	if (input.scheduledFor && input.policy.scheduledLeadMinutes != null) {
		const scheduledUntil =
			input.scheduledFor.getTime() - input.policy.scheduledLeadMinutes * 60_000
		until = Math.max(until, scheduledUntil)
	}
	if (input.dropCutoffAt) {
		until = Math.min(until, input.dropCutoffAt.getTime())
	}
	const untilDate = new Date(until)

	if (input.kitchenStarted) return refuse('order_in_preparation', untilDate)
	if (input.now.getTime() >= until) {
		return refuse('cancel_window_closed', untilDate)
	}
	return { allowed: true, until: untilDate, reason: null }
}

/**
 * `GET /orders/:id/cancel` and the answer of `POST /orders/:id/cancel`
 * (receipt token or order-link token, plus `Idempotency-Key` on POST). No PII.
 * `refund` describes the provider refund the cancel started (online orders).
 */
export const guestCancelResponseSchema = z.object({
	allowed: z.boolean(),
	until: z.string().nullable(),
	reason: z.enum(GUEST_CANCEL_REFUSAL_REASONS).nullable(),
	/** Present on the POST answer once the order is cancelled. */
	status: z.string().optional(),
	refund: z
		.object({
			status: z.enum(['none', 'pending', 'succeeded', 'failed']),
			amountCents: z.number().int().min(0),
		})
		.optional(),
})
export type GuestCancelResponse = z.infer<typeof guestCancelResponseSchema>

// ---------------------------------------------------------------------------
// Order acceptance (#107)
// ---------------------------------------------------------------------------

export const ORDER_ACCEPTANCE_MODES = ['auto', 'manual'] as const
export type OrderAcceptanceMode = (typeof ORDER_ACCEPTANCE_MODES)[number]

/** "Reject automatically after": minutes a location may choose. */
export const ORDER_ACCEPTANCE_TIMEOUT_CHOICES = [3, 5, 10] as const
export type OrderAcceptanceTimeoutMinutes =
	(typeof ORDER_ACCEPTANCE_TIMEOUT_CHOICES)[number]
export const DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES = 5

/** A scheduled order must be decided this long before it fires. */
export const ORDER_ACCEPTANCE_SCHEDULED_BUFFER_MINUTES = 30

/**
 * One location's acceptance policy (`acceptance[locationId]` of the order
 * context). `minTotalCents` (order total, minor units) and `scheduledOnly`
 * narrow which orders wait; when both are set an order must match both.
 */
export const orderAcceptancePolicySchema = z.object({
	mode: z.enum(ORDER_ACCEPTANCE_MODES),
	timeoutMinutes: z.union([z.literal(3), z.literal(5), z.literal(10)]),
	minTotalCents: z.number().int().min(0).nullable(),
	scheduledOnly: z.boolean(),
})
export type OrderAcceptancePolicy = z.infer<typeof orderAcceptancePolicySchema>

/** `acceptance` of the order context, per location id (manual ones only). */
export type OrderAcceptanceContext = Record<string, OrderAcceptancePolicy>

export const ORDER_ACCEPTANCE_AUTO: Readonly<OrderAcceptancePolicy> =
	Object.freeze({
		mode: 'auto',
		timeoutMinutes: DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
		minTotalCents: null,
		scheduledOnly: false,
	})

/**
 * Reads one location's policy from the order context's `acceptance`. Fails
 * closed to Automatic: missing, malformed or unknown location is `auto`.
 */
export function readOrderAcceptancePolicy(
	value: unknown,
	locationId: string,
): OrderAcceptancePolicy {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { ...ORDER_ACCEPTANCE_AUTO }
	}
	if (!Object.prototype.hasOwnProperty.call(value, locationId)) {
		return { ...ORDER_ACCEPTANCE_AUTO }
	}
	const parsed = orderAcceptancePolicySchema.safeParse(
		(value as Record<string, unknown>)[locationId],
	)
	return parsed.success ? parsed.data : { ...ORDER_ACCEPTANCE_AUTO }
}

/**
 * Whether a new order waits for a person to accept it. Only web and QR
 * poster orders (pickup or delivery) can wait: QR table rounds, tab rounds,
 * dine-in and Station sales never do. `minTotalCents` is strictly "over".
 */
export function orderNeedsAcceptance(
	policy: OrderAcceptancePolicy | null | undefined,
	order: {
		totalCents: number
		scheduled: boolean
		fulfillment: string
		source?: string | null
		tabId?: string | null
	},
): boolean {
	if (!policy || policy.mode !== 'manual') return false
	if (
		order.fulfillment === 'dine_in' ||
		order.tabId ||
		order.source === 'qr_table'
	) {
		return false
	}
	if (
		policy.minTotalCents != null &&
		order.totalCents <= policy.minTotalCents
	) {
		return false
	}
	if (policy.scheduledOnly && !order.scheduled) return false
	return true
}

/**
 * When an order waiting for acceptance is rejected automatically
 * (`not_accepted_in_time`).
 *
 * - ASAP: `now + timeoutMinutes`.
 * - Scheduled (`scheduledFireAt`, when the kitchen should start): the
 *   restaurant has until 30 minutes before the fire time, and never less
 *   than the configured minutes (`max(now + timeout, fireAt - 30 min)`), so
 *   an order placed days ahead can be accepted later and one due soon still
 *   gets the configured minutes.
 */
export function acceptanceDeadline(
	policy: Pick<OrderAcceptancePolicy, 'timeoutMinutes'>,
	input: { now: Date; scheduledFireAt?: Date | null },
): Date {
	const asap = input.now.getTime() + policy.timeoutMinutes * 60_000
	if (!input.scheduledFireAt) return new Date(asap)
	const beforeFire =
		input.scheduledFireAt.getTime() -
		ORDER_ACCEPTANCE_SCHEDULED_BUFFER_MINUTES * 60_000
	return new Date(Math.max(asap, beforeFire))
}

// ---------------------------------------------------------------------------
// Guest (public) order view additions
// ---------------------------------------------------------------------------

/**
 * Fields the public receipt and order-link views (`GET /orders/:id`) may carry
 * for cancel, acceptance and refunds. All optional so older regions still
 * parse. No PII and no internal reason: `cancelReason` is only ever a
 * guest-visible one.
 */
export const publicOrderLifecycleSchema = z.object({
	/** When an order waiting for the restaurant is rejected automatically. */
	acceptanceDeadlineAt: z.string().nullable().optional(),
	/** The order was turned down while waiting for acceptance. */
	rejected: z.boolean().optional(),
	cancelledBy: z.enum(ORDER_CANCELLED_BY_VALUES).nullable().optional(),
	cancelReason: z.enum(GUEST_VISIBLE_CANCEL_REASONS).nullable().optional(),
	refundStatus: z
		.enum(['none', 'pending', 'failed', 'partial', 'full'])
		.optional(),
	refundPendingCents: z.number().int().min(0).optional(),
	cancel: z
		.object({ allowed: z.boolean(), until: z.string().nullable() })
		.optional(),
})
export type PublicOrderLifecycle = z.infer<typeof publicOrderLifecycleSchema>
