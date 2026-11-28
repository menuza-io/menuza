import { z } from 'zod'
import { minorToMajor, minorToMajorText } from '#app/utils/money-input.ts'

/** Mirrors operatorOrder() in apps/tenant-api/src/services/order-service.ts. */
export const orderSchema = z.object({
	id: z.string(),
	/** `c_<id>` or `g_<id>` person key, null for a guest checkout (or no access). */
	customerKey: z.string().nullable().optional(),
	number: z.string(),
	status: z.string(),
	paymentStatus: z.string(),
	paymentMethod: z.enum(['handoff', 'online']),
	paymentProcessor: z.string().nullable().optional(),
	/** Card brand and last four digits (#423); null when absent or not permitted. */
	cardBrand: z.string().nullable().optional().catch(null),
	cardLast4: z.string().nullable().optional().catch(null),
	revision: z.number().int().optional().catch(1),
	timeChangeCount: z.number().int().optional().catch(0),
	paidCents: z.number().int().optional().catch(undefined),
	amountDueCents: z.number().int().optional().catch(undefined),
	taxExempt: z
		.object({
			ref: z.string(),
			org: z.string(),
		})
		.nullable()
		.optional()
		.catch(null),
	subtotalCents: z.number().int().optional(),
	taxCents: z.number().int().optional(),
	deliveryFeeCents: z.number().int().optional(),
	tipCents: z.number().int().optional(),
	/** Null when the guest typed an exact tip amount. */
	tipPercent: z.number().nullable().optional(),
	/**
	 * The guest service fee (#123) before its tax (the tax is in `taxCents`),
	 * the name the guest saw, and what a refund can give back for it (fee plus
	 * tax unless prices include tax). Missing from an older region: no fee.
	 */
	serviceFeeCents: z.number().int().optional().catch(undefined),
	serviceFeeLabel: z.string().nullable().optional().catch(undefined),
	serviceFeeChargeCents: z.number().int().optional().catch(undefined),
	packagingFeeCents: z.number().int().optional().catch(undefined),
	packagingFeeLabel: z.string().nullable().optional().catch(undefined),
	utensilsRequested: z.boolean().nullable().optional().catch(undefined),
	largeOrderExtraMinutes: z.number().int().optional().catch(undefined),
	/** Over the location's large-order alert threshold when placed (#300). */
	largeOrder: z.boolean().optional().catch(undefined),
	/** The order has alcohol: staff "Check ID" at handoff (#167). */
	hasAlcohol: z.boolean().optional().catch(undefined),
	/** A free test order (#119): badged TEST, never charged, never a sale. */
	isTest: z.boolean().optional().catch(undefined),
	/** "Did the ticket print?" for a test order: yes, no, or not asked yet. */
	testPrintAnswer: z.enum(['yes', 'no']).nullable().optional().catch(undefined),
	/** The guest stated an allergy at checkout (#294). */
	guestAllergy: z.boolean().optional().catch(undefined),
	/** The time the guest asked for (ISO); null for as soon as possible. */
	scheduledFor: z.string().nullable().optional().catch(undefined),
	pickupInstructions: z.string().nullable().optional().catch(undefined),
	/**
	 * A catering order (#124, #361): the event, head count, the guest's notes and
	 * how the total is collected. Null or missing for every other order.
	 */
	catering: z
		.object({
			eventAt: z.string().nullable(),
			guestCount: z.number().int().nullable(),
			notes: z.string().nullable(),
			quoteId: z.string().nullable(),
			depositPercent: z.number().int().nullable(),
			depositCents: z.number().int().nullable(),
			paidCents: z.number().int().nullable(),
			balanceCents: z.number().int(),
			balanceOwedCents: z.number().int(),
			balanceState: z.enum(['due', 'paid', 'void']).nullable(),
			balanceDueAt: z.string().nullable(),
		})
		.nullable()
		.optional()
		.catch(undefined),
	/** A loyalty reward's discount, taken off the subtotal before tax. */
	loyaltyDiscountCents: z.number().int(),
	/** Non-loyalty discounts on the lines, in cents (missing means none). */
	discountCents: z.number().int().optional().catch(undefined),
	/** Discount taken off the delivery fee, in cents. */
	deliveryDiscountCents: z.number().int().optional().catch(undefined),
	/** Applied discounts; read through `appliedDiscounts()`, never trusted. */
	discounts: z.array(z.unknown()).optional().catch(undefined),
	/** Why a `payment_review` order waits, when the region knows. */
	reviewReason: z
		.literal('discount_limit_exceeded')
		.nullable()
		.optional()
		.catch(undefined),
	totalCents: z.number().int(),
	/** Recorded by an operator as returned; the payment status stays `paid`. */
	refundedCents: z.number().int(),
	/** Each recorded refund, oldest first (the order's own page only). */
	refunds: z
		.array(
			z.object({
				id: z.string(),
				amountCents: z.number().int(),
				/** The part of the amount that is the service fee and its tax. */
				serviceFeeCents: z.number().int().optional().catch(undefined),
				note: z.string().nullable(),
				createdAt: z.string(),
				/** Missing from an older region: a record that already succeeded. */
				kind: z.enum(['record', 'provider']).optional().catch(undefined),
				status: z
					.enum(['pending', 'succeeded', 'failed'])
					.optional()
					.catch(undefined),
				failureCode: z.string().nullable().optional().catch(undefined),
			}),
		)
		.optional(),
	/** Provider refunds started but not yet settled; they reserve money. */
	refundPendingCents: z.number().int().optional().catch(undefined),
	/** Paid minus refunded minus pending; the region's figure wins. */
	refundableCents: z.number().int().optional().catch(undefined),
	refundStatus: z
		.enum(['none', 'pending', 'failed', 'partial', 'full'])
		.optional()
		.catch(undefined),
	/** Short provider code of the newest failed refund. */
	refundFailureCode: z.string().nullable().optional().catch(undefined),
	/** The card issuer is disputing the payment. */
	disputed: z.boolean().optional().catch(undefined),
	disputeStatus: z.string().nullable().optional().catch(undefined),
	/** Why the order was cancelled (an internal value) and by whom. */
	cancelReason: z.string().nullable().optional().catch(undefined),
	cancelledBy: z.string().nullable().optional().catch(undefined),
	/** Manual acceptance (#107): when a waiting order is turned down by itself. */
	acceptanceDeadlineAt: z.string().nullable().optional().catch(undefined),
	acceptedAt: z.string().nullable().optional().catch(undefined),
	/** Set when the order was turned down while it waited (or timed out). */
	rejectedReason: z.string().nullable().optional().catch(undefined),
	currency: z.string(),
	createdAt: z.string().nullable(),
	paidAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	cancelledAt: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
	contact: z.object({
		name: z.string(),
		phone: z.string(),
		email: z.string().nullable(),
	}),
	fulfillment: z.string(),
	location: z.object({ id: z.string(), name: z.string() }),
	lines: z.array(
		z.object({
			kind: z.enum(['catalog', 'custom']).optional().catch(undefined),
			itemId: z.string().optional().catch(undefined),
			variantId: z.string().nullable().optional().catch(undefined),
			itemName: z.string(),
			quantity: z.number(),
			unitPriceCents: z.number(),
			totalCents: z.number(),
			instructions: z.string().nullable(),
			/** The size or other variant chosen ("Large"), when the item has one. */
			variantNames: z.array(z.string()).optional(),
			options: z.array(
				z.object({
					groupId: z.string().optional().catch(undefined),
					optionId: z.string().optional().catch(undefined),
					optionName: z.string(),
					quantity: z.number(),
				}),
			),
		}),
	),
	pickup: z
		.object({
			date: z.string(),
			time: z.string(),
			timezone: z.string(),
		})
		.nullable(),
	drop: z.object({ slug: z.string() }).nullable(),
	/** QR dine-in round: the table and the tab it belongs to. */
	table: z.object({ id: z.string(), label: z.string() }).nullable().optional(),
	tabId: z.string().nullable().optional(),
	source: z.string().nullable().optional(),
	delivery: z
		.object({
			address: z.string(),
			city: z.string().nullable(),
			unit: z.string().nullable(),
			postalCode: z.string().nullable().optional(),
			notes: z.string().nullable(),
			feeCents: z.number().int().nullable().optional(),
		})
		.nullable(),
	/** IANA zone of the order's location; null when the region sent none. */
	timeZone: z
		.string()
		.refine((zone) => {
			try {
				new Intl.DateTimeFormat('en', { timeZone: zone })
				return true
			} catch {
				return false
			}
		})
		.nullable()
		.default(null)
		.catch(null),
	/** The time promised to the guest (ISO); null when none was promised. */
	promisedAt: z.string().nullable().default(null).catch(null),
	/** End of an ASAP delivery range (ISO); null otherwise. */
	promisedUntil: z.string().nullable().default(null).catch(null),
	/** Bumped by every push-back; sent back so a stale screen is refused. */
	promisedVersion: z.number().int().default(0).catch(0),
	/** Minutes already pushed back (the region caps the total). */
	promisedDelayMinutes: z.number().int().default(0).catch(0),
	/** Where the guest came from (#115): `direct`, `email`, `short_link`, ... */
	attributionSource: z.string().default('direct').catch('direct'),
	attribution: z
		.object({
			utmSource: z.string().optional(),
			utmCampaign: z.string().optional(),
			coupon: z.string().optional(),
		})
		.nullable()
		.default(null)
		.catch(null),
	/** The broadcast or automation's name, when the order came from one. */
	campaignName: z.string().nullable().default(null).catch(null),
})
export type Order = z.infer<typeof orderSchema>

/**
 * One step of an order's timeline (#243), from `GET /operator/orders/:id`:
 * when it happened and who or which screen did it. `actorId` is an opaque
 * member, device or staff id (the page names a member from its own list), and
 * the row holds no guest data. Mirrors `orderTimeline` in `@repo/common`.
 */
export const orderTimelineEntrySchema = z.object({
	step: z.enum([
		'placed',
		'accepted',
		'declined',
		'started',
		'ready',
		'handed_over',
		'out_for_delivery',
		'delivered',
	]),
	at: z.number(),
	actorKind: z.enum(['guest', 'operator', 'station', 'system']),
	actorId: z.string().nullable(),
	source: z.enum([
		'app',
		'station_orders',
		'station_kitchen',
		'guest',
		'payment',
		'system',
	]),
	offline: z.boolean(),
	minutesSincePlaced: z.number().nullable(),
})
export type OrderTimelineEntry = z.infer<typeof orderTimelineEntrySchema>

export type AppliedOrderDiscount = {
	discountId: string
	name: string
	code: string | null
	amountMinor: number
	deliveryAmountMinor: number
}

const appliedDiscountSchema = z.object({
	discountId: z.string().catch(''),
	name: z.string().catch(''),
	code: z.string().nullable().catch(null),
	amountMinor: z.number().int().min(0).catch(0),
	deliveryAmountMinor: z.number().int().min(0).catch(0),
})

/** The discounts applied to an order. Unknown shapes are skipped. */
export function appliedDiscounts(order: {
	discounts?: unknown
}): AppliedOrderDiscount[] {
	if (!Array.isArray(order.discounts)) return []
	const result: AppliedOrderDiscount[] = []
	for (const entry of order.discounts) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const parsed = appliedDiscountSchema.parse(entry)
		if (parsed.amountMinor <= 0 && parsed.deliveryAmountMinor <= 0) continue
		result.push(parsed)
	}
	return result
}

/** A free order (a discount covered the total) needs no payment at all. */
export function isPaymentNotRequired(order: {
	paymentStatus: string
}): boolean {
	return order.paymentStatus === 'not_required'
}

/** Body of `POST /operator/orders/:id/refunds`: an amount, or everything left. */
export type OrderRefundBody =
	| { full: true; note: string }
	| {
			amountCents: number
			/** Also give back the service fee (#123), on top of `amountCents`. */
			includeServiceFee?: true
			note: string
	  }

/** What a paid order can still give back, in cents. */
export function refundableCents(order: {
	totalCents: number
	refundedCents: number
}): number {
	return Math.max(0, order.totalCents - order.refundedCents)
}

/**
 * What a refund can still give back for the service fee: what the order
 * charged for it less the fee part of refunds already made or waiting on the
 * provider (a failed one gives it back). 0 for an order with no fee.
 */
export function serviceFeeRefundableCents(order: {
	serviceFeeChargeCents?: number
	refunds?: ReadonlyArray<{
		serviceFeeCents?: number
		status?: 'pending' | 'succeeded' | 'failed'
	}>
}): number {
	const charged = Math.max(0, order.serviceFeeChargeCents ?? 0)
	const taken = (order.refunds ?? []).reduce(
		(sum, refund) =>
			refund.status === 'failed' ? sum : sum + (refund.serviceFeeCents ?? 0),
		0,
	)
	return Math.max(0, charged - taken)
}

/**
 * What a provider refund can still take, in cents: the region's figure, or
 * paid minus refunded minus pending when an older region sends none.
 */
export function providerRefundableCents(order: {
	totalCents: number
	refundedCents: number
	refundPendingCents?: number
	refundableCents?: number
}): number {
	if (typeof order.refundableCents === 'number') {
		return Math.max(0, order.refundableCents)
	}
	return Math.max(
		0,
		order.totalCents - order.refundedCents - (order.refundPendingCents ?? 0),
	)
}

/**
 * The payment word for lists and headers. A paid order whose money came back
 * reads Refunded or Partly refunded; the stored status stays `paid`. Mirrors
 * `orderRefundState()` in `@repo/common/restaurant-orders`.
 */
export function paymentDisplayStatus(order: {
	paymentStatus: string
	totalCents: number
	refundedCents: number
}): string {
	const refunded = order.refundedCents
	if (order.paymentStatus !== 'paid' || refunded <= 0) {
		return order.paymentStatus
	}
	return refunded >= order.totalCents ? 'refunded' : 'partly_refunded'
}

/**
 * Receipt lines preserve every catalog locale as a JSON map string
 * (`{"en":"…","ar":"…"}`). Operators read them in their own locale.
 */
export function localizedName(value: string, locale: string): string {
	if (!value.startsWith('{')) return value
	try {
		const parsed: unknown = JSON.parse(value)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>
			const picked =
				record[locale] ??
				record[locale.split('-')[0] ?? ''] ??
				record.en ??
				Object.values(record).find((entry) => typeof entry === 'string')
			if (typeof picked === 'string') return picked
		}
	} catch {
		// Not a locale map; fall through to the raw value.
	}
	return value
}

export function formatMoney(
	cents: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minorToMajor(cents, currency))
	} catch {
		return `${minorToMajorText(cents, currency)} ${currency.toUpperCase()}`
	}
}

/** Next forward step for the primary button, or undefined when there is none. */
export function nextOrderStatus(status: string): string | undefined {
	return (
		{
			accepted: 'preparing',
			preparing: 'ready',
			ready: 'completed',
			// Late payment: the operator decides to honour the order.
			payment_review: 'preparing',
		} as Record<string, string>
	)[status]
}

/** Total minutes an order's promised time can be pushed back. */
export const MAX_PROMISED_DELAY_MINUTES = 90
export const PUSH_BACK_MINUTES = [5, 10, 15] as const
export type PushBackMinutes = (typeof PUSH_BACK_MINUTES)[number]
/** Statuses where the promised time can still move. */
export const PUSHABLE_ORDER_STATUSES = ['accepted', 'preparing', 'ready']

/** An order placed under manual acceptance that nobody has decided yet. */
export const WAITING_ORDER_STATUS = 'pending_acceptance'

export const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'expired']

export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return '?'
	const first = Array.from(parts[0] ?? '')[0] ?? ''
	const last = parts.length > 1 ? Array.from(parts.at(-1) ?? '')[0] : ''
	return `${first}${last ?? ''}`.toUpperCase()
}

/** "3 min ago" style hint; empty when the date is invalid. */
export function relativeTime(
	iso: string | null | undefined,
	locale: string,
	now: number = Date.now(),
): string {
	if (!iso) return ''
	const time = new Date(iso).getTime()
	if (Number.isNaN(time)) return ''
	const seconds = Math.round((time - now) / 1000)
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31536000],
		['month', 2592000],
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	]
	try {
		const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
		for (const [unit, size] of units) {
			if (Math.abs(seconds) >= size)
				return formatter.format(Math.round(seconds / size), unit)
		}
		return formatter.format(0, 'second')
	} catch {
		return ''
	}
}

export function formatDateTime(
	iso: string | null | undefined,
	locale: string,
): string {
	if (!iso) return ''
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(date)
	} catch {
		return date.toLocaleString()
	}
}
