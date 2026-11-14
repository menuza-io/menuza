import { z } from 'zod'
import {
	deliveryArrivalWindowMinutes,
	isLocationOpenForOrdering,
	locationDeliveryArrivalMinutes,
} from './location-availability.ts'

export { deliveryArrivalWindowMinutes, locationDeliveryArrivalMinutes }

/**
 * Promised ready (pickup) or arrival (delivery) time of an online order (#109),
 * and the rules for the kitchen pushing it back. Pure: no I/O, no clock.
 *
 * At placement:
 * - Scheduled: the time the guest chose (`scheduledFor`, the pickup time or
 *   the delivery time), one time, no range.
 * - As soon as possible, pickup: now + the location's prep time + busy
 *   minutes (`estimatedPrepTime` of `isLocationOpenForOrdering`, the same
 *   estimate the ordering page shows) + the large-order extra prep when the
 *   order is over the location's large-order threshold. One time, no range.
 * - As soon as possible, delivery: now + prep time + busy minutes (once) +
 *   the large-order extra + the location's delivery time range, from
 *   `deliveryArrivalWindowMinutes`, the one rule the ordering pages and
 *   checkout show too (15 min prep and a 25-45 min range is 40-60 min; they
 *   show it without the large-order extra, which needs the cart).
 *   `promisedAt` is the earliest arrival, `promisedUntil` the latest.
 * - Table rounds and drops: no promised time.
 * Times are rounded up to the whole minute.
 */

/** Push-back steps the kitchen and the Orders page offer, in minutes. */
export const PROMISED_DELAY_CHOICES = [5, 10, 15] as const
export type PromisedDelayMinutes = (typeof PROMISED_DELAY_CHOICES)[number]
/** Most minutes an order's promised time may be pushed back in total. */
export const MAX_PROMISED_DELAY_MINUTES = 90
/** A single push-back of at least this many minutes tells the guest. */
export const PROMISED_DELAY_NOTIFY_MINUTES = 10

export const promisedDelayMinutesSchema = z.union([
	z.literal(5),
	z.literal(10),
	z.literal(15),
])

/**
 * One location's large-order rule (`largeOrder[locationId]` of the order
 * context). `threshold` is in MAJOR currency units for `amount` (100 is
 * 100.00, as the App stores it) and an item count for `items`.
 */
export const largeOrderRuleSchema = z.object({
	threshold: z.number().finite().positive(),
	thresholdType: z.enum(['amount', 'items']),
	extraPrepMinutes: z.number().int().positive().max(240),
})
export type LargeOrderRule = z.infer<typeof largeOrderRuleSchema>

/**
 * Reads the rule for one location from the order context's `largeOrder`.
 * Fails safe: anything missing or malformed is no rule (no extra time).
 */
export function readLargeOrderRule(
	value: unknown,
	locationId: string,
): LargeOrderRule | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	if (!Object.prototype.hasOwnProperty.call(value, locationId)) return null
	const parsed = largeOrderRuleSchema.safeParse(
		(value as Record<string, unknown>)[locationId],
	)
	return parsed.success ? parsed.data : null
}

/**
 * "Trigger when order exceeds" (the location form): strictly over the
 * threshold. `amount` compares the item subtotal (before tax, tip, delivery
 * and discounts) in minor units with the threshold converted the way the order
 * engine converts catalog prices (x100); `items` compares total quantity.
 */
export function isLargeOrder(
	rule: LargeOrderRule | null,
	order: { subtotalCents: number; itemCount: number },
): boolean {
	if (!rule) return false
	if (rule.thresholdType === 'items') return order.itemCount > rule.threshold
	return order.subtotalCents > Math.round(rule.threshold * 100)
}

/**
 * The large-order extra prep minutes for a cart: the rule's extra when the
 * cart is over its threshold, otherwise 0. The one function placement
 * (`computePromisedTime`) and checkout use, so they cannot drift.
 */
export function largeOrderExtraMinutes(
	rule: LargeOrderRule | null,
	order: { subtotalCents: number; itemCount: number },
): number {
	return rule && isLargeOrder(rule, order) ? rule.extraPrepMinutes : 0
}

type PromiseLocation = Parameters<typeof isLocationOpenForOrdering>[0]

export type PromisedTimeInput = {
	now: Date
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	/** Validated scheduled time (ISO), null for as soon as possible. */
	scheduledFor: string | null
	/** A drop order (pickup window): no promised time. */
	drop?: boolean
	location: PromiseLocation
	largeOrder: LargeOrderRule | null
	subtotalCents: number
	/** Total item quantity. */
	itemCount: number
}

export type PromisedTime = {
	promisedAt: Date | null
	promisedUntil: Date | null
}

const MINUTE = 60_000

function ceilToMinute(ms: number): number {
	return Math.ceil(ms / MINUTE) * MINUTE
}

export function computePromisedTime(input: PromisedTimeInput): PromisedTime {
	const none: PromisedTime = { promisedAt: null, promisedUntil: null }
	if (input.fulfillment === 'dine_in' || input.drop) return none
	if (input.scheduledFor) {
		const ms = new Date(input.scheduledFor).getTime()
		if (!Number.isFinite(ms)) return none
		return { promisedAt: new Date(ms), promisedUntil: null }
	}
	const now = input.now.getTime()
	const availability = isLocationOpenForOrdering(input.location, input.now)
	const extra = largeOrderExtraMinutes(input.largeOrder, input)
	if (input.fulfillment === 'delivery') {
		const range = locationDeliveryArrivalMinutes(input.location, input.now, {
			largeOrderExtraMinutes: extra,
		})
		const from = ceilToMinute(now + range.min * MINUTE)
		const to = ceilToMinute(now + range.max * MINUTE)
		return {
			promisedAt: new Date(from),
			promisedUntil: to > from ? new Date(to) : null,
		}
	}
	return {
		promisedAt: new Date(
			ceilToMinute(now + (availability.estimatedPrepTime + extra) * MINUTE),
		),
		promisedUntil: null,
	}
}

export type PromisedDelayRefusal =
	'no_promised_time' | 'order_closed' | 'stale_version' | 'delay_limit'

/** The order fields a push-back reads. */
export type PromisedDelayOrder = {
	status: string
	promisedAt: Date | null
	promisedUntil: Date | null
	promisedVersion: number
	promisedDelayMinutes: number
}

/** Statuses whose promised time can still move: the order is live. */
export const PROMISED_DELAY_STATUSES: readonly string[] = [
	'accepted',
	'preparing',
	'ready',
]

/**
 * Checks and computes one push-back. Order of checks: closed, no time, stale
 * version, cap. Only later, never earlier: `minutes` is one of the choices.
 */
export function planPromisedDelay(
	order: PromisedDelayOrder,
	minutes: PromisedDelayMinutes,
	expectedVersion: number,
):
	| {
			ok: true
			promisedAt: Date
			promisedUntil: Date | null
			version: number
			delayMinutes: number
	  }
	| { ok: false; code: PromisedDelayRefusal } {
	if (!PROMISED_DELAY_STATUSES.includes(order.status))
		return { ok: false, code: 'order_closed' }
	if (!order.promisedAt) return { ok: false, code: 'no_promised_time' }
	if (order.promisedVersion !== expectedVersion)
		return { ok: false, code: 'stale_version' }
	if (!PROMISED_DELAY_CHOICES.includes(minutes))
		throw new RangeError('minutes must be one of the delay choices')
	const total = order.promisedDelayMinutes + minutes
	if (total > MAX_PROMISED_DELAY_MINUTES)
		return { ok: false, code: 'delay_limit' }
	const shift = minutes * MINUTE
	return {
		ok: true,
		promisedAt: new Date(order.promisedAt.getTime() + shift),
		promisedUntil: order.promisedUntil
			? new Date(order.promisedUntil.getTime() + shift)
			: null,
		version: order.promisedVersion + 1,
		delayMinutes: total,
	}
}
