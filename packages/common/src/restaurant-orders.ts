import {
	hasRealCoordinates,
	normalizePostalCode,
	resolveZoneForPoint,
	toAsciiDigits,
	type CoverageFailureReason,
} from '@repo/geo'
import {
	orderContextDiscountsTolerantSchema,
	orderDiscountsRequestSchema,
} from '@repo/discounts'
import { z } from 'zod'
import { giftCardCheckoutInputSchema } from './gift-card-contract.ts'
import { PHOTO_TEST_KEY_PATTERN } from './photo-test-key.ts'
import { orderAttributionInputSchema } from './order-attribution.ts'
import { giftCardPaymentRiskSchema } from './gift-cards.ts'
import {
	DAYS_OF_WEEK,
	DEFAULT_SCHEDULING,
	resolveTipSettings,
	type TipSettings,
} from './location-types.ts'
import {
	activeBusyExtraPrepMinutes,
	isLocationOpenForOrdering,
	localDateAndTimeToUtc,
	type LocationOrderingAvailability,
} from './location-availability.ts'
import { parsePrepSchedule } from './location-settings.ts'
import { isSoldOn, type MenuChannel } from './menu-channels.ts'
import { prepMinutesAt } from './prep-schedule.ts'
import { parseUtensilsSettings } from './checkout-utensils.ts'
import {
	type DailyDishAvailability,
	dailyDishLimitsContextSchema,
} from './daily-dish-limits.ts'
import { orderLimitExemptFromCatalog } from './order-limit-exempt.ts'
import { orderDishUnits } from './slot-usage.ts'
import {
	computeReadySlotCapacity,
	type ReadySlotCapacitySpec,
} from './ready-slot-capacity.ts'
import {
	menuOrderTypeFor,
	parseMenuPricingRules,
	resolveMenuItemPrice,
	resolveMenuOptionPrice,
	type MenuOrderType,
} from './menu-pricing.ts'
import { generatePickupSlots, getDropDisplayStatus } from './menu-types.ts'
import {
	orderNumberFormatSchema,
	posLocationStationSettingsSchema,
} from './pos-orders.ts'
import { orderMarketingConsentSchema } from './marketing-consent.ts'
import {
	ORDER_CANCELLED_BY_VALUES,
	ORDER_STORED_CANCEL_REASONS,
	orderCancelReasonSchema,
	orderRejectReasonSchema,
} from './order-lifecycle.ts'
import {
	ORDER_DISPUTE_STATUSES,
	operatorOrderRefundSchema,
	refundNoteSchema,
} from './order-refunds.ts'
import {
	readLargeOrderRule,
	promisedDelayMinutesSchema,
	type LargeOrderRule,
} from './promised-time.ts'
import { discountedTaxableCents } from './pos-discount-base.ts'
import {
	canonicalTip,
	computeTip,
	orderTipSchema,
	requestedTip,
	requestsTip,
	TIP_TOO_LARGE_CODE,
} from './order-tips.ts'
import {
	checkOrderCaps,
	ORDER_TOO_LARGE_CODE,
	readOrderCapsForLocation,
} from './order-caps.ts'
import {
	computePackagingFee,
	readPackagingFeePolicy,
	PACKAGING_FEE_UNAVAILABLE_CODE,
	type PackagingFeeFulfillment,
	type PackagingFeeSettings,
} from './packaging-fee.ts'
import {
	computeServiceFee,
	readServiceFeePolicy,
	type ServiceFeeFulfillment,
	type ServiceFeeSettings,
} from './service-fee.ts'
import {
	orderLoyaltySelectionSchema,
	type OrderLoyaltySelection,
} from './order-loyalty.ts'

/**
 * Regional restaurant ordering: shared, PII-free contracts and the pure
 * server-side repricing + validation engine.
 *
 * The browser never sends prices. The regional tenant-api lazy-fetches fresh
 * non-PII catalog context from the App (`GET /resources/order-context`) and
 * re-derives every cent from menu/drop data using this module. Customer PII
 * (contact, delivery address) is only ever handled by the regional tenant-api.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESTAURANT_TURNSTILE_ACTION = 'place-order'

/** Durable order lifecycle states. */
export const RESTAURANT_ORDER_STATUS_VALUES = [
	'accepted',
	'preparing',
	'ready',
	'completed',
	'cancelled',
	'expired',
	'payment_review',
	/**
	 * Waiting for a person to accept it (#107, manual acceptance). Holds slot
	 * and drop capacity like `accepted`, but is not a kitchen ticket and does
	 * not count as a sale, for inventory, loyalty or discounts until accepted.
	 */
	'pending_acceptance',
] as const
export type RestaurantOrderStatus =
	(typeof RESTAURANT_ORDER_STATUS_VALUES)[number]

/**
 * Statuses that consume capacity (slots, drop inventory).
 * cancelled / expired / payment_review release it.
 */
export const RESTAURANT_ACTIVE_ORDER_STATUSES = [
	'pending_acceptance',
	'accepted',
	'preparing',
	'ready',
	'completed',
] as const

/**
 * Statuses that count as a sale (reports): the capacity-holding ones minus
 * `pending_acceptance`, which may still be rejected.
 */
export const RESTAURANT_SALES_ORDER_STATUSES = [
	'accepted',
	'preparing',
	'ready',
	'completed',
] as const

export const RESTAURANT_PAYMENT_STATUS_VALUES = [
	'unpaid',
	'pending',
	'paid',
	'failed',
	'expired',
	'review',
	/** A free order (total 0 after discounts): accepted with no payment step. */
	'not_required',
] as const
export type RestaurantPaymentStatus =
	(typeof RESTAURANT_PAYMENT_STATUS_VALUES)[number]

export const RESTAURANT_MAX_LINES = 50
export const RESTAURANT_MAX_LINE_QUANTITY = 50
export const RESTAURANT_MAX_TOTAL_QUANTITY = 200
export const RESTAURANT_MAX_OPTIONS_PER_LINE = 50
export const RESTAURANT_MAX_INSTRUCTIONS_LENGTH = 280

export const RESTAURANT_TIP_MIN_PERCENT = 0
export const RESTAURANT_TIP_MAX_PERCENT = 30

/** Checkout hold for online orders when the catalog carries no drop hold. */
export const RESTAURANT_ONLINE_HOLD_MINUTES = 10
export const RESTAURANT_MIN_HOLD_MINUTES = 1
export const RESTAURANT_MAX_HOLD_MINUTES = 120

/** Nested modifier groups walk at most this many fixpoint passes (cycle guard). */
const MAX_MODIFIER_FIXPOINT_PASSES = 8

const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Catalog prices are stored in major currency units; orders use integer cents. */
export function dollarsToCents(value: number): number {
	return Math.round(value * 100)
}

function clampInt(
	value: number,
	min: number,
	max: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) return fallback
	const rounded = Math.round(value)
	if (rounded < min || rounded > max) return fallback
	return rounded
}

// ---------------------------------------------------------------------------
// Error / result types
// ---------------------------------------------------------------------------

export type RestaurantOrderErrorCode =
	| 'invalid_request'
	| 'location_not_found'
	| 'drop_not_found'
	| 'drop_closed'
	| 'pickup_required'
	| 'pickup_not_supported'
	| 'invalid_pickup_window'
	| 'invalid_pickup_slot'
	| 'lead_time'
	| 'ordering_closed'
	| 'ordering_paused'
	| 'pickup_disabled'
	| 'delivery_disabled'
	| 'delivery_unavailable'
	| 'delivery_coverage_unverified'
	| 'delivery_quote_expired'
	| 'schedule_unavailable'
	| 'minimum_order'
	| 'delivery_address_required'
	| 'delivery_not_allowed'
	| 'tips_disabled'
	| 'unknown_item'
	| 'item_unavailable'
	| 'unknown_variant'
	| 'variant_required'
	| 'variant_unavailable'
	| 'unknown_option'
	| 'option_unavailable'
	| 'unknown_modifier_group'
	| 'duplicate_option'
	| 'invalid_half'
	| 'invalid_quantity'
	| 'invalid_combination'
	| 'required_modifier'
	| 'modifier_limit'
	| 'option_quantity_limit'
	| 'instructions_not_allowed'
	| 'per_order_limit'
	| 'total_quantity_limit'
	| 'dine_in_disabled'
	| 'dine_in_not_allowed'
	| 'tip_too_large'
	| 'service_fee_unavailable'
	| 'order_too_large'
	| 'packaging_fee_unavailable'

export type RestaurantOrderError = {
	status: 400 | 403 | 404 | 409 | 422 | 503
	code: RestaurantOrderErrorCode
	message: string
	/** Machine-readable context for the client, never personal data. */
	details?: Record<string, unknown>
}

export type PriceRestaurantOrderResult =
	| { ok: true; result: PricedRestaurantOrder }
	| { ok: false; error: RestaurantOrderError }

// ---------------------------------------------------------------------------
// Browser → regional API request schema (contract: docs/restaurant-ordering-contract.md)
// ---------------------------------------------------------------------------

const phoneSchema = z
	.string()
	.trim()
	.transform((value) => value.replace(/[\s\-().]/g, ''))
	.refine((value) => /^\+?\d{7,20}$/.test(value), {
		message: 'Enter a valid phone number',
	})

export const restaurantOrderOptionSelectionSchema = z.strictObject({
	groupId: z.string().min(1).max(100),
	optionId: z.string().min(1).max(100),
	half: z.enum(['whole', 'left', 'right']).optional(),
	quantity: z
		.number()
		.int()
		.min(1)
		.max(RESTAURANT_MAX_LINE_QUANTITY)
		.optional(),
})

export const restaurantOrderLineSchema = z.strictObject({
	itemId: z.string().min(1).max(100),
	variantId: z.string().min(1).max(100).optional(),
	quantity: z.number().int().min(1).max(RESTAURANT_MAX_LINE_QUANTITY),
	instructions: z
		.string()
		.trim()
		.max(RESTAURANT_MAX_INSTRUCTIONS_LENGTH)
		.optional(),
	options: z
		.array(restaurantOrderOptionSelectionSchema)
		.max(RESTAURANT_MAX_OPTIONS_PER_LINE)
		.default([]),
})

export { orderLoyaltySelectionSchema, type OrderLoyaltySelection }

const restaurantOrderContactSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	phone: phoneSchema.optional(),
	email: z.string().trim().email().max(254).optional(),
})

/** Every field an order request can carry, before cross-field rules. */
const restaurantOrderObjectSchema = z.strictObject({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	idempotencyKey: z.string().regex(UUID_REGEX, 'idempotencyKey must be a UUID'),
	locale: z.string().trim().min(2).max(10).default('en'),
	locationId: z.string().min(1).max(100),
	dropSlug: z.string().trim().min(1).max(120).optional(),
	pickup: z
		.strictObject({
			windowId: z.string().min(1).max(100),
			time: z.string().regex(HH_MM_REGEX, 'Pickup time must be HH:MM'),
		})
		.optional(),
	/**
	 * `dine_in` is a QR table round: it needs an `X-Table-Token` or
	 * `X-Tab-Token` header, pays at tab close, and carries contact only as
	 * the organization's QR settings require.
	 */
	fulfillment: z.enum(['pickup', 'delivery', 'dine_in']),
	paymentMethod: z.enum(['handoff', 'online']),
	contact: restaurantOrderContactSchema,
	/** Set by Sites when the menu was opened from an order-ahead QR poster. */
	source: z.enum(['qr_poster']).nullable().optional(),
	/**
	 * The loyalty reward the customer picked; re-quoted server-side and
	 * refused when it no longer matches. The schema accepts it on a dine-in
	 * round so the order service can refuse it with its own code (422
	 * `loyalty_on_tab`): a tab's reward is chosen when the tab is paid.
	 */
	loyalty: orderLoyaltySelectionSchema.optional(),
	/**
	 * A gift card applied after discounts and loyalty (#110): a typed code or a
	 * card saved to the guest's account, and the amount the page showed. The
	 * region takes at most the balance and at most what is left to pay and
	 * refuses a different amount with 409 `gift_card_changed`. Refused on a
	 * table round (a tab pays at the table).
	 */
	giftCard: giftCardCheckoutInputSchema.optional(),
	/**
	 * A coupon code and the total discount the customer was shown. The region
	 * re-evaluates every discount; `expectedDiscountMinor` is only compared
	 * (409 `discount_changed`), never trusted.
	 */
	discounts: orderDiscountsRequestSchema.optional(),
	/**
	 * Marketing boxes the guest ticked. Recorded with the order only for a
	 * signed-in customer, ignored otherwise; not part of the idempotency hash
	 * (a retry places the same order and records nothing again).
	 */
	marketingConsent: orderMarketingConsentSchema.optional(),
	/**
	 * Where the guest came from (#115): UTM values, a Menuza campaign, a short
	 * link, kept by the browser or the customer app for up to 7 days. Strict,
	 * every value at most 100 characters; stored with the order for reporting
	 * only, and not part of the idempotency hash.
	 */
	attribution: orderAttributionInputSchema.optional(),
	/**
	 * The photo each dish in a photo test (#192) showed this guest. Sent only
	 * when set (the body is strict). Ids and the App's signed key only; the
	 * region keeps the entries whose key checks out and that name a dish in the
	 * order.
	 */
	photoTests: z
		.array(
			z.strictObject({
				testId: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
				itemId: z.string().min(1).max(100),
				variant: z.enum(['A', 'B']),
				/** Signed by the App for this test and dish; unsigned entries are dropped. */
				key: z.string().regex(PHOTO_TEST_KEY_PATTERN),
			}),
		)
		.max(20)
		.optional(),
	/**
	 * "Text me order updates": transactional texts about this order only, never
	 * marketing consent. Refused on a table round; ignored without a phone or
	 * off the US node (stored false).
	 */
	smsUpdates: z.boolean().optional(),
	delivery: z
		.strictObject({
			// Free-text address + city are required only without a quote
			// token; with one, the signed coordinates/address are authoritative.
			address: z.string().trim().max(200).optional(),
			city: z.string().trim().max(100).optional(),
			unit: z.string().trim().max(50).optional(),
			notes: z.string().trim().max(200).optional(),
			quoteToken: z.string().min(16).max(4096).optional(),
		})
		.optional(),
	/** ISO-8601 instant; null/absent = ASAP. */
	scheduledFor: z
		.string()
		.datetime({ offset: true })
		.max(40)
		.nullable()
		.optional(),
	tipPercent: z
		.number()
		.int()
		.min(RESTAURANT_TIP_MIN_PERCENT)
		.max(RESTAURANT_TIP_MAX_PERCENT)
		.default(0),
	/**
	 * The tip: a share of the subtotal or an exact amount (#118). Takes the
	 * place of `tipPercent`, which stays for clients that predate it; sending
	 * both with a non-zero `tipPercent` is refused.
	 */
	tip: orderTipSchema.optional(),
	/**
	 * The service fee (#123) the guest was shown, minor units. The region
	 * prices the fee itself and refuses a different amount with 409
	 * `service_fee_changed`; it is never trusted as a price. A missing value
	 * reads as 0, so a client that predates the fee is refused where one is due.
	 */
	expectedServiceFeeMinor: z
		.number()
		.int()
		.min(0)
		.max(1_000_000_000)
		.optional(),
	expectedPackagingFeeMinor: z
		.number()
		.int()
		.min(0)
		.max(1_000_000_000)
		.optional(),
	/** When the location asks (#257); ignored unless utensils are on. */
	utensilsRequested: z.boolean().optional(),
	/** Dine-in cap by head count (#422). */
	guestCount: z.number().int().min(1).max(500).optional(),
	lines: z.array(restaurantOrderLineSchema).min(1).max(RESTAURANT_MAX_LINES),
	turnstileToken: z.string().min(1).max(2048).optional(),
	/** Opaque client device identifier used for referral abuse prevention. */
	referralDeviceId: z.string().trim().min(1).max(128).optional(),
})

/** The cross-field shape the refinement sees (a quote may drop contact). */
type OrderRefinementValue = {
	contact?: { name?: string; phone?: string }
	fulfillment: 'pickup' | 'delivery' | 'dine_in'
	paymentMethod: 'handoff' | 'online'
	tipPercent: number
	tip?: z.infer<typeof orderTipSchema> | undefined
	dropSlug?: string
	pickup?: unknown
	delivery?: { address?: string; city?: string; quoteToken?: string }
	scheduledFor?: string | null
	source?: 'qr_poster' | null
	smsUpdates?: boolean
	lines: Array<{ quantity: number }>
}

function refineOrderRequest(
	value: OrderRefinementValue,
	context: z.RefinementCtx,
	options: { requireContact: boolean },
) {
	if (value.fulfillment === 'dine_in') {
		refineDineInRequest(value, context)
		if (value.smsUpdates === true) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['smsUpdates'],
				message: 'Order update texts are not available for table orders',
			})
		}
	} else if (options.requireContact) {
		if (!value.contact?.name) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['contact', 'name'],
				message: 'Enter your name',
			})
		}
		if (!value.contact?.phone) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['contact', 'phone'],
				message: 'Enter a valid phone number',
			})
		}
	}
	if (value.tip && value.tipPercent !== 0) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['tip'],
			message: 'Send either tip or tipPercent',
		})
	}
	if (value.fulfillment === 'delivery' && !value.delivery) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['delivery'],
			message: 'A delivery address is required',
		})
	}
	if (value.delivery && !value.delivery.quoteToken) {
		if ((value.delivery.address ?? '').length < 5) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['delivery', 'address'],
				message: 'Enter a delivery address',
			})
		}
		if (!value.delivery.city) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['delivery', 'city'],
				message: 'Enter a delivery city',
			})
		}
	}
	if (value.dropSlug && value.scheduledFor) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['scheduledFor'],
			message: 'Drops use pickup windows instead of scheduled times',
		})
	}
	if (value.fulfillment === 'pickup' && value.delivery) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['delivery'],
			message: 'Delivery details are not valid for pickup orders',
		})
	}
	if (value.dropSlug && !value.pickup) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['pickup'],
			message: 'Choose a pickup time',
		})
	}
	if (!value.dropSlug && value.pickup) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['pickup'],
			message: 'Pickup windows are only available for drops',
		})
	}
	const totalQuantity = value.lines.reduce(
		(sum, line) => sum + line.quantity,
		0,
	)
	if (totalQuantity > RESTAURANT_MAX_TOTAL_QUANTITY) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['lines'],
			message: 'This order is too large',
		})
	}
}

export const restaurantOrderRequestSchema =
	restaurantOrderObjectSchema.superRefine((value, context) =>
		refineOrderRequest(value, context, { requireContact: true }),
	)

export type RestaurantOrderRequest = z.infer<
	typeof restaurantOrderRequestSchema
>

/**
 * A loyalty checkout quote: priced exactly like a placement, but a read — no
 * idempotency key, no contact, and no reward pick inside the order (the pick
 * rides as the quote body's `selection`). Not strict: a placement-shaped
 * body still parses, its idempotency key and contact are simply dropped.
 */
export const restaurantOrderQuoteSchema = z
	.object({ ...restaurantOrderObjectSchema.shape })
	.omit({
		idempotencyKey: true,
		loyalty: true,
		marketingConsent: true,
		smsUpdates: true,
	})
	.extend({ contact: restaurantOrderContactSchema.optional() })
	.superRefine((value, context) =>
		refineOrderRequest(value, context, { requireContact: false }),
	)

export type RestaurantOrderQuoteRequest = z.infer<
	typeof restaurantOrderQuoteSchema
>

/**
 * The public `POST /orders/quote` body: a placement without the idempotency
 * key and contact, with the same `discounts` (coupon code) and optional
 * `loyalty` pick, so the quoted total is the one placement will re-check.
 * Not strict, like the loyalty quote: a placement-shaped body still parses.
 */
export const restaurantOrderDiscountQuoteSchema = z
	.object({ ...restaurantOrderObjectSchema.shape })
	.omit({ idempotencyKey: true, marketingConsent: true, smsUpdates: true })
	.extend({ contact: restaurantOrderContactSchema.optional() })
	.superRefine((value, context) =>
		refineOrderRequest(value, context, { requireContact: false }),
	)

export type RestaurantOrderDiscountQuoteRequest = z.infer<
	typeof restaurantOrderDiscountQuoteSchema
>

/**
 * A dine-in round: the table (or the open tab) is proven by a header token,
 * so the body carries only what the guest ordered. Drops, pickup windows,
 * delivery, scheduling, tips and online prepay belong to other flows: the tab
 * is paid once, at close.
 */
function refineDineInRequest(
	value: {
		dropSlug?: string
		pickup?: unknown
		delivery?: unknown
		scheduledFor?: string | null
		tipPercent: number
		tip?: z.infer<typeof orderTipSchema> | undefined
		paymentMethod: 'handoff' | 'online'
		source?: 'qr_poster' | null
	},
	context: z.RefinementCtx,
) {
	const reject = (path: string, message: string) =>
		context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })
	if (value.dropSlug) reject('dropSlug', 'Drops are not available at the table')
	if (value.pickup) reject('pickup', 'Pickup times are not valid at the table')
	if (value.delivery) reject('delivery', 'Delivery is not valid at the table')
	if (value.scheduledFor) {
		reject('scheduledFor', 'Table orders are sent to the kitchen now')
	}
	if (requestsTip(value)) {
		reject(value.tip ? 'tip' : 'tipPercent', 'Add a tip when you pay')
	}
	if (value.paymentMethod !== 'handoff') {
		reject('paymentMethod', 'Table orders are paid when you close the tab')
	}
	if (value.source) reject('source', 'Table orders have their own source')
}
export type RestaurantOrderLineRequest = z.infer<
	typeof restaurantOrderLineSchema
>

// ---------------------------------------------------------------------------
// App → regional internal payload schemas (docs/restaurant-ordering-contract.md)
// Authenticated with Bearer INTERNAL_COMMAND_TOKEN; unknown properties are
// rejected so no extra fields ever ride along.
// ---------------------------------------------------------------------------

export const orderQuoteRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	paymentToken: z.string().min(16).max(128),
})

export const orderPaymentSessionRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	sessionId: z.string().min(8).max(200),
	processor: z.enum(['connect', 'checkout']),
})

export const orderPaymentStatusRequestSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	orderId: z.string().min(1).max(100),
	sessionId: z.string().min(8).max(200),
	processor: z.enum(['connect', 'checkout']),
	status: z.enum(['paid', 'failed', 'expired']),
	amountCents: z.number().int().min(0),
	currency: z.string().length(3),
	/** One payment's provider id (Checkout.com shares the session per order). */
	paymentId: z.string().min(1).max(200).optional(),
	/**
	 * What the provider said about the payment's risk (gift card purchases
	 * only; ids and flags, never card data). Additive: an App that predates it
	 * sends none and the purchase is judged on the region's own rules.
	 */
	risk: giftCardPaymentRiskSchema.optional(),
})

/**
 * Operator lifecycle writes (PATCH /operator/orders/:id). The contract only
 * allows forward service states plus cancel; `expired` and `payment_review`
 * are system-owned and can never be set directly.
 */
/**
 * `PATCH /operator/orders/:id`: either a status change (optionally marking a
 * handoff order paid), or a push-back of the promised time. The two never mix:
 * a body with both is refused (400), so each write has one meaning.
 */
export const operatorOrderStatusPatchSchema = z
	.strictObject({
		status: z.enum([
			'accepted',
			'preparing',
			'ready',
			'completed',
			'cancelled',
		]),
		markPaid: z.boolean().optional(),
		/**
		 * Why the order is cancelled (`status: 'cancelled'` only). Optional in
		 * the schema so older callers (Station, App before the cancel dialog)
		 * keep working; the region may require it for paid online orders and
		 * stores none otherwise. Not for an order waiting for acceptance: that
		 * takes `rejectReason`.
		 */
		cancelReason: orderCancelReasonSchema.optional(),
		/**
		 * Cancelling a paid online order: `full` books a provider refund of
		 * everything still refundable (the region answers the refund intent for
		 * the App to complete); `none` keeps the money. `status: 'cancelled'`
		 * only.
		 */
		refund: z.enum(['none', 'full']).optional(),
		/**
		 * Rejecting an order waiting for acceptance (`pending_acceptance` →
		 * `cancelled`). `status: 'cancelled'` only, never with `cancelReason`.
		 */
		rejectReason: orderRejectReasonSchema.optional(),
	})
	.superRefine((body, ctx) => {
		if (body.status !== 'cancelled') {
			for (const key of ['cancelReason', 'refund', 'rejectReason'] as const) {
				if (body[key] !== undefined) {
					ctx.addIssue({
						code: 'custom',
						path: [key],
						message: 'Only when cancelling.',
					})
				}
			}
		}
		if (body.cancelReason !== undefined && body.rejectReason !== undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['rejectReason'],
				message: 'Send cancelReason or rejectReason, not both.',
			})
		}
	})

/** Pushes the promised time back by 5, 10 or 15 minutes (never earlier). */
export const operatorOrderDelayPatchSchema = z.strictObject({
	delayMinutes: promisedDelayMinutesSchema,
	/** The `promisedVersion` the screen showed; another value is 409 `stale_version`. */
	expectedPromisedVersion: z.number().int().nonnegative(),
})

export const operatorOrderPatchSchema = z.union([
	operatorOrderStatusPatchSchema,
	operatorOrderDelayPatchSchema,
])

export type OperatorOrderPatch = z.infer<typeof operatorOrderPatchSchema>

/** POST /operator/orders/limits/reset (#108). */
export const operatorSlotLimitsResetSchema = z.strictObject({
	locationId: z.string().min(1).max(100),
})

export type OperatorSlotLimitsReset = z.infer<
	typeof operatorSlotLimitsResetSchema
>

export const operatorSlotLimitsTodayQuerySchema = z.strictObject({
	locationId: z.string().min(1).max(100),
	fulfillment: z.enum(['pickup', 'delivery']),
})

/**
 * Money an operator records as returned for a paid online order
 * (POST /operator/orders/:id/refunds, with an `Idempotency-Key`). It is a
 * record only: the region never calls a payment provider. Either an amount,
 * or `full` for everything not refunded yet. Stored as `kind = record`,
 * `status = succeeded`. Provider refunds use
 * `orderProviderRefundRequestSchema` (same shape) through the App.
 */
export const operatorOrderRefundRequestSchema = z.union([
	z.strictObject({
		amountCents: z.number().int().min(1).max(100_000_000),
		/**
		 * Also give back the guest service fee (#123), on top of `amountCents`.
		 * Only with an amount: a full refund always includes the fee.
		 */
		includeServiceFee: z.boolean().optional(),
		note: refundNoteSchema,
	}),
	z.strictObject({
		full: z.literal(true),
		note: refundNoteSchema,
	}),
])

export type OperatorOrderRefundRequest = z.infer<
	typeof operatorOrderRefundRequestSchema
>

export type OrderRefundState = 'none' | 'partial' | 'full'

/** How much of what the customer paid came back. */
export function orderRefundState(order: {
	totalCents: number
	refundedCents: number
}): OrderRefundState {
	const refunded = order.refundedCents
	if (refunded <= 0) return 'none'
	return refunded >= order.totalCents ? 'full' : 'partial'
}

/**
 * Cancel, acceptance, dispute and refund fields the operator order JSON
 * (`operatorOrder()` in tenant-api, plus `refunds` / `refundPendingCents` on
 * the single-order routes) carries. Every field has a default so an older
 * region still parses.
 */
export const operatorOrderLifecycleSchema = z.object({
	cancelReason: z
		.enum(ORDER_STORED_CANCEL_REASONS)
		.nullable()
		.default(null)
		.catch(null),
	cancelledBy: z
		.enum(ORDER_CANCELLED_BY_VALUES)
		.nullable()
		.default(null)
		.catch(null),
	/** Set when the order was rejected (manually or by the timeout). */
	rejectedReason: z
		.enum(ORDER_STORED_CANCEL_REASONS)
		.nullable()
		.default(null)
		.catch(null),
	acceptanceDeadlineAt: z.string().nullable().default(null).catch(null),
	acceptedAt: z.string().nullable().default(null).catch(null),
	/** The payment has an open or lost dispute (refunds are refused). */
	disputed: z.boolean().default(false).catch(false),
	disputeStatus: z
		.enum(ORDER_DISPUTE_STATUSES)
		.nullable()
		.default(null)
		.catch(null),
	disputedAt: z.string().nullable().default(null).catch(null),
	/** Provider refunds still pending (single-order routes). */
	refundPendingCents: z.number().int().min(0).optional().catch(undefined),
	refunds: z.array(operatorOrderRefundSchema).optional().catch(undefined),
})
export type OperatorOrderLifecycle = z.infer<
	typeof operatorOrderLifecycleSchema
>

/**
 * Canonical, PII-scrubbing-free fingerprint of the order semantics. The same
 * checkout attempt retried with the same idempotency key produces the same
 * hash; any semantic change produces a different one (409 on replay).
 * Routing/display-only fields (slug, host, locale, turnstile token) are
 * deliberately excluded so a retry is not poisoned by presentation changes.
 */
export function canonicalOrderRequest(request: RestaurantOrderRequest): string {
	return JSON.stringify({
		locationId: request.locationId,
		dropSlug: request.dropSlug ?? null,
		pickup: request.pickup
			? { windowId: request.pickup.windowId, time: request.pickup.time }
			: null,
		fulfillment: request.fulfillment,
		paymentMethod: request.paymentMethod,
		...canonicalTip(request),
		contact: {
			name: request.contact.name ?? null,
			phone: request.contact.phone ?? null,
			email: request.contact.email ?? null,
		},
		// Only when present, so hashes of requests without it never change.
		...(request.source ? { source: request.source } : {}),
		...(request.loyalty ? { loyalty: request.loyalty } : {}),
		...(request.discounts ? { discounts: request.discounts } : {}),
		...(request.giftCard ? { giftCard: request.giftCard } : {}),
		...(request.smsUpdates ? { smsUpdates: true } : {}),
		...(request.expectedServiceFeeMinor !== undefined
			? { expectedServiceFeeMinor: request.expectedServiceFeeMinor }
			: {}),
		// The checkout rules (#408, #257, #422), only when sent, so a request
		// without them hashes as before and a retry that changes one conflicts
		// instead of replaying the first order.
		...(request.expectedPackagingFeeMinor !== undefined
			? { expectedPackagingFeeMinor: request.expectedPackagingFeeMinor }
			: {}),
		...(request.utensilsRequested !== undefined
			? { utensilsRequested: request.utensilsRequested }
			: {}),
		...(request.guestCount !== undefined
			? { guestCount: request.guestCount }
			: {}),
		delivery: request.delivery
			? {
					address: request.delivery.address ?? null,
					city: request.delivery.city ?? null,
					unit: request.delivery.unit ?? null,
					notes: request.delivery.notes ?? null,
					quoteToken: request.delivery.quoteToken ?? null,
				}
			: null,
		scheduledFor: request.scheduledFor
			? new Date(request.scheduledFor).toISOString()
			: null,
		lines: request.lines.map((line) => ({
			itemId: line.itemId,
			variantId: line.variantId ?? null,
			quantity: line.quantity,
			instructions: line.instructions ?? null,
			options: line.options.map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				half: option.half ?? null,
				quantity: option.quantity ?? null,
			})),
		})),
	})
}

// ---------------------------------------------------------------------------
// App → regional catalog context schemas (GET /resources/order-context)
// Mirrors the App serializers (`apps/app/app/utils/menu/public-serializers.server.ts`,
// `resources+/sites.menu.ts`, `resources+/sites.drop.ts`). Passthrough so new
// public fields do not break ordering; the engine relies only on these fields.
// ---------------------------------------------------------------------------

const availabilityStatusSchema = z.string()
const channelsFieldSchema = z
	.union([z.array(z.string()), z.string()])
	.nullable()
	.optional()

const locationOverrideSchema = z
	.object({
		entityType: z.string(),
		entityId: z.string(),
		isEnabled: z.boolean().nullable().optional(),
		price: z.number().nullable().optional(),
		availabilityStatus: z.string().nullable().optional(),
		channels: channelsFieldSchema,
	})
	.loose()

export type LocationOverride = z.infer<typeof locationOverrideSchema>

export type PublicMenuOptionContext = {
	id: string
	displayName: string
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	minSelections?: number | null
	maxSelections?: number | null
	applySalesTax?: boolean
	availabilityStatus: string
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupContext[]
	[key: string]: unknown
}

export type PublicModifierGroupContext = {
	id: string
	name: string
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections?: number
	maxSelections?: number | null
	availabilityStatus: string
	options?: PublicMenuOptionContext[]
	[key: string]: unknown
}

const publicMenuOptionContextSchema: z.ZodType<PublicMenuOptionContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				price: z.number().finite().min(0),
				priceWhole: z.number().finite().min(0).nullable().optional(),
				priceLeft: z.number().finite().min(0).nullable().optional(),
				priceRight: z.number().finite().min(0).nullable().optional(),
				minSelections: z.number().int().min(0).nullable().optional(),
				maxSelections: z.number().int().min(1).nullable().optional(),
				applySalesTax: z.boolean().optional(),
				availabilityStatus: availabilityStatusSchema,
				nestedModifierGroupIds: z.array(z.string()).optional(),
				nestedModifierGroups: z
					.array(publicModifierGroupContextSchema)
					.optional(),
			})
			.loose(),
	)

const publicModifierGroupContextSchema: z.ZodType<PublicModifierGroupContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				name: z.string(),
				selectionType: z.enum(['single', 'multiple', 'quantity', 'pizza']),
				minSelections: z.number().int().min(0).optional(),
				maxSelections: z.number().int().min(1).nullable().optional(),
				availabilityStatus: availabilityStatusSchema,
				options: z.array(publicMenuOptionContextSchema).optional(),
			})
			.loose(),
	)

export type PublicMenuItemContext = {
	id: string
	displayName: string
	price: number
	availabilityStatus: string
	channels?: readonly string[] | string | null
	/** False: the item's own price is not taxed (options have their own flag). Missing reads as true. */
	applySalesTax?: boolean
	/** True: the item never receives a discount. Missing reads as false. */
	excludeFromDiscounts?: boolean
	/** True: the item does not count toward slot limits (#256). */
	excludeFromOrderLimits?: boolean
	variations?: {
		groups?: Array<{
			id: string
			name: string
			values?: Array<{ id: string; name: string }>
		}>
		variants?: Array<{
			id: string
			valueIds?: string[]
			price: number
			availabilityStatus: string
			/** True: this variant never receives a discount. */
			excludeFromDiscounts?: boolean
		}>
	}
	modifierGroups?: PublicModifierGroupContext[]
	[key: string]: unknown
}

const publicMenuItemContextSchema: z.ZodType<PublicMenuItemContext> = z.lazy(
	() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				price: z.number().finite().min(0),
				availabilityStatus: availabilityStatusSchema,
				channels: channelsFieldSchema,
				applySalesTax: z.boolean().optional(),
				excludeFromDiscounts: z.boolean().optional(),
				excludeFromOrderLimits: z.boolean().optional(),
				variations: z
					.object({
						groups: z
							.array(
								z.object({
									id: z.string(),
									name: z.string(),
									values: z
										.array(z.object({ id: z.string(), name: z.string() }))
										.optional(),
								}),
							)
							.optional(),
						variants: z
							.array(
								z.object({
									id: z.string(),
									valueIds: z.array(z.string()).optional(),
									price: z.number().finite().min(0),
									availabilityStatus: availabilityStatusSchema,
									excludeFromDiscounts: z.boolean().optional(),
								}),
							)
							.optional(),
					})
					.optional(),
				modifierGroups: z.array(publicModifierGroupContextSchema).optional(),
			})
			.loose(),
)

export type PublicMenuCategoryContext = {
	id: string
	displayName: string
	availabilityStatus: string
	channels?: readonly string[] | string | null
	excludeFromOrderLimits?: boolean
	items?: PublicMenuItemContext[]
	subcategories?: PublicMenuCategoryContext[]
	[key: string]: unknown
}

const publicMenuCategoryContextSchema: z.ZodType<PublicMenuCategoryContext> =
	z.lazy(() =>
		z
			.object({
				id: z.string().min(1),
				displayName: z.string(),
				availabilityStatus: availabilityStatusSchema,
				channels: channelsFieldSchema,
				items: z.array(publicMenuItemContextSchema).optional(),
				subcategories: z.array(publicMenuCategoryContextSchema).optional(),
			})
			.loose(),
	)

export type PublicMenuContext = {
	id: string
	displayName: string
	menuType: string
	specialInstructions?: boolean
	availabilityStatus: string
	channels?: readonly string[] | string | null
	categories?: PublicMenuCategoryContext[]
	[key: string]: unknown
}

const publicMenuContextSchema: z.ZodType<PublicMenuContext> = z.lazy(() =>
	z
		.object({
			id: z.string().min(1),
			displayName: z.string(),
			menuType: z.string(),
			specialInstructions: z.boolean().optional(),
			availabilityStatus: availabilityStatusSchema,
			channels: channelsFieldSchema,
			categories: z.array(publicMenuCategoryContextSchema).optional(),
		})
		.loose(),
)

const weeklyScheduleContextSchema = z.array(
	z.object({
		day: z.enum(DAYS_OF_WEEK),
		isOpen: z.boolean(),
		slots: z
			.array(
				z.object({
					start: z.string().regex(HH_MM_REGEX),
					end: z.string().regex(HH_MM_REGEX),
				}),
			)
			.default([]),
	}),
)

const specialHoursContextSchema = z
	.array(
		z.object({
			id: z.string(),
			date: z.string().regex(ISO_DATE_REGEX),
			isOpen: z.boolean(),
			slots: z
				.array(
					z.object({
						start: z.string().regex(HH_MM_REGEX),
						end: z.string().regex(HH_MM_REGEX),
					}),
				)
				.default([]),
			note: z.string().optional(),
		}),
	)
	.default([])

const deliveryZoneContextSchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']),
	restriction: z.enum(['allowed', 'disallowed']),
	type: z.enum(['radius', 'zip_code', 'polygon']),
	radius: z
		.object({
			value: z.number().min(0),
			unit: z.enum(['miles', 'km']),
		})
		.optional(),
	zipCodes: z.array(z.string()).default([]),
	polygon: z.array(z.object({ lat: z.number(), lng: z.number() })).default([]),
	minimumOrder: z.number().min(0).default(0),
	deliveryFee: z.number().min(0).default(0),
	enabled: z.boolean().default(true),
})

export const publicLocationContextSchema = z
	.object({
		id: z.string().min(1),
		name: z.string(),
		slug: z.string().optional(),
		phone: z.string().nullable().optional(),
		timezone: z.string().default('UTC'),
		taxRate: z.number().finite().min(0).default(0),
		/**
		 * Menu prices already include tax (VAT). Optional so order contexts
		 * published before the field existed still parse as tax-exclusive.
		 */
		taxInclusive: z.boolean().default(false),
		/** Seller's tax (VAT) registration number, printed on receipts. */
		vatNumber: z.string().nullable().optional(),
		prepTime: z.number().int().min(0).default(15),
		currency: z.enum(['USD', 'CAD', 'SAR']).default('USD'),
		isDefault: z.boolean().optional(),
		/**
		 * Text guests of counter and phone orders when Kitchen marks them ready
		 * (Settings, Terminals). Off when missing, so an older App never turns
		 * it on. Policy only: no guest data.
		 */
		readyText: z.boolean().default(false),
		fulfillmentOptions: z
			.object({
				pickup: z.boolean().default(true),
				delivery: z.boolean().default(true),
				dineIn: z.boolean().default(true),
				curbside: z.boolean().default(false),
			})
			.loose()
			.default({ pickup: true, delivery: true, dineIn: true, curbside: false }),
		inHouseTips: z
			.object({
				pickupTips: z.boolean().default(true),
				deliveryTips: z.boolean().default(true),
				dineInTips: z.boolean().default(true),
			})
			.loose()
			.default({
				pickupTips: true,
				deliveryTips: true,
				dineInTips: true,
			}),
		/**
		 * The location's tip buttons (`TipSettingsSchema`). Read with
		 * `resolveTipSettings`, never parsed here: a bad value falls back to the
		 * default buttons, it never blocks ordering.
		 */
		tipSettings: z.unknown().optional(),
		scheduling: z
			.object({
				scheduledOrdersEnabled: z.boolean().default(true),
				advanceOrderDays: z.number().int().min(1).max(90).default(7),
			})
			.loose()
			.optional(),
		deliveryConfig: z
			.object({
				providers: z
					.array(z.enum(['in_house', 'uber_eats', 'doordash', 'restricted']))
					.default([]),
				estimatedDeliveryTimeMin: z.number().min(0),
				estimatedDeliveryTimeMax: z.number().min(0),
			})
			.loose()
			.optional(),
		deliveryZones: z.array(deliveryZoneContextSchema).default([]),
		address: z
			.object({
				formattedAddress: z.string().optional(),
				city: z.string().optional(),
				state: z.string().optional(),
				postalCode: z.string().optional(),
				country: z.string().optional(),
				lat: z.number().nullable().optional(),
				lng: z.number().nullable().optional(),
			})
			.loose()
			.nullable()
			.optional(),
		onlineHours: weeklyScheduleContextSchema.nullable().optional(),
		storeHours: weeklyScheduleContextSchema.nullable().optional(),
		specialHours: specialHoursContextSchema.optional(),
		/**
		 * Operator pause and busy mode. Optional so contexts published before
		 * the fields existed still parse; evaluated against the clock.
		 */
		orderingPause: z
			.object({ until: z.string().nullable() })
			.nullable()
			.optional(),
		busyMode: z
			.object({
				extraPrepMinutes: z.number().int().min(0).max(240),
				until: z.string().nullable(),
			})
			.nullable()
			.optional(),
		onlineOrderingSettings: z.unknown().optional(),
		slotLimitSettings: z.unknown().optional(),
		prepSchedule: z.unknown().optional(),
		prayerPauseSettings: z.unknown().optional(),
		/** KSA (or other enabled region): prayer pauses may apply. */
		prayerPauseRegion: z.boolean().optional(),
		/** Per-location Station register policy (#372, #171, #380). */
		stationSettings: posLocationStationSettingsSchema.optional(),
		/** Per-location order number format and daily reset (#371). */
		orderNumberFormat: orderNumberFormatSchema.optional(),
	})
	.loose()

export type PublicLocationContext = z.infer<typeof publicLocationContextSchema>

export const restaurantOrderContextSchema = z
	.object({
		orgId: z.string().min(1),
		dataRegion: z.enum(['us', 'ksa']),
		menu: z
			.object({
				organization: z
					.object({
						id: z.string().min(1),
						name: z.string().optional(),
						slug: z.string(),
						currency: z.string().min(3).max(3),
						defaultLocale: z.string().optional(),
						locales: z.array(z.string()).optional(),
					})
					.loose(),
				locations: z.array(publicLocationContextSchema).default([]),
				menus: z.array(publicMenuContextSchema).default([]),
				locationOverrides: z
					.record(z.string(), z.array(locationOverrideSchema))
					.optional(),
				/**
				 * Live pricing rules (#388). Read with `parseMenuPricingRules`, which
				 * drops a malformed rule instead of failing the context.
				 */
				pricingRules: z.unknown().optional(),
			})
			.loose(),
		drop: z
			.object({
				organization: z
					.object({
						id: z.string().min(1),
						name: z.string().optional(),
						slug: z.string(),
						currency: z.string().min(3).max(3),
					})
					.loose(),
				drop: z
					.object({
						id: z.string().min(1),
						title: z.string(),
						slug: z.string().min(1),
						description: z.string().nullable().optional(),
						status: z.string(),
						ordersOpenAt: z.string().nullable().optional(),
						ordersCloseAt: z.string().nullable().optional(),
						visibility: z.enum(['public', 'unlisted']).optional(),
						checkoutHoldMinutes: z
							.number()
							.default(RESTAURANT_ONLINE_HOLD_MINUTES),
						menu: z
							.object({
								id: z.string().min(1),
								displayName: z.string().optional(),
								specialInstructions: z.boolean().default(true),
							})
							.loose(),
					})
					.loose(),
				pickupWindows: z
					.array(
						z
							.object({
								id: z.string().min(1),
								locationId: z.string().min(1),
								location: z
									.object({
										id: z.string().min(1),
										name: z.string().optional(),
										phone: z.string().nullable().optional(),
										timezone: z.string().optional(),
									})
									.loose()
									.nullable()
									.optional(),
								date: z.string().regex(ISO_DATE_REGEX),
								startTime: z.string().regex(HH_MM_REGEX),
								endTime: z.string().regex(HH_MM_REGEX),
								slotIntervalMinutes: z.number().int().min(1).default(30),
								maxOrdersPerSlot: z.number().int().min(1).nullable().optional(),
								orderLeadTimeMinutes: z.number().int().min(0).default(0),
								slots: z
									.array(
										z.object({
											time: z.string().regex(HH_MM_REGEX),
											displayTime: z.string().optional(),
										}),
									)
									.default([]),
							})
							.loose(),
					)
					.default([]),
				inventoryOverrides: z
					.array(
						z
							.object({
								id: z.string().optional(),
								entityType: z.enum(['item', 'category']),
								entityId: z.string().min(1),
								inventory: z.number().int().min(0).nullable().optional(),
								maxPerOrder: z.number().int().min(1).nullable().optional(),
								maxPerPickupSlot: z.number().int().min(1).nullable().optional(),
							})
							.loose(),
					)
					.default([]),
				categories: z.array(publicMenuCategoryContextSchema).default([]),
			})
			.loose()
			.nullable(),
		onlinePayment: z.object({
			enabled: z.boolean(),
			processor: z.enum(['connect', 'checkout']).nullable(),
		}),
		/**
		 * Active discount definitions and codes. Read one record at a time: a
		 * discount or code row that does not parse is dropped (and logged by id),
		 * the valid ones stay. A missing or unusable field reads as off. A bad
		 * discount payload never blocks ordering.
		 */
		discounts: orderContextDiscountsTolerantSchema.optional(),
		/**
		 * Guest order messages policy (`ordering.guest_messages` and the
		 * operator's switches). Read with `readGuestMessagesPolicy`, never parsed
		 * here: a bad value turns messages off, it never blocks ordering.
		 */
		guestMessages: z.unknown().optional(),
		/**
		 * Large-order extra prep per location id (`largeOrderRuleSchema`). Read
		 * with `readLargeOrderRule`, never parsed here: a bad value adds no time,
		 * it never blocks ordering.
		 */
		largeOrder: z.unknown().optional(),
		/**
		 * Guest self-cancel per location id (`ordering.guest_cancel`, #111):
		 * only locations that offer a window, only while the flag is on. Read
		 * with `readGuestCancelPolicy`, never parsed here: missing or bad is off.
		 */
		guestCancel: z.unknown().optional(),
		/**
		 * Manual order acceptance per location id
		 * (`ordering.manual_acceptance`, #107): only `manual` locations, only
		 * while the flag is on. Read with `readOrderAcceptancePolicy`: missing
		 * or bad is Automatic.
		 */
		acceptance: z.unknown().optional(),
		/**
		 * Guest service fee per location id (`ordering.service_fee`, #123): only
		 * locations that have it on, only while the flag is on. Read with
		 * `readServiceFeePolicy`, never parsed here: missing is off, but a fee
		 * that is on and cannot be read refuses the order (never dropped).
		 */
		serviceFee: z.unknown().optional(),
		packagingFee: z.unknown().optional(),
		orderCaps: z.unknown().optional(),
		/** Pickup instructions per location id (#251). Localized JSON string. */
		pickupInstructions: z.record(z.string(), z.string()).optional(),
		/** Utensils question per location id (#257). */
		utensils: z
			.record(
				z.string(),
				z.object({
					enabled: z.boolean(),
					defaultRequested: z.boolean(),
				}),
			)
			.optional(),
		/** Per-slot capacity (`ordering.slot_limits`, #108). */
		slotLimits: z.object({ enabled: z.boolean().default(false) }).optional(),
		/** Daily dish quantity caps (`ordering.daily_dish_limits`, #409). */
		dailyDishLimits: dailyDishLimitsContextSchema.optional(),
	})
	.loose()

export type RestaurantOrderContext = z.infer<
	typeof restaurantOrderContextSchema
>

export {
	canonicalTip,
	computeTip,
	maxTipMinor,
	orderTipSchema,
	requestedTip,
	requestsTip,
	TIP_CAP_MAJOR,
	TIP_TOO_LARGE_CODE,
	type OrderTip,
	type TipResult,
} from './order-tips.ts'

export {
	computeServiceFee,
	defaultServiceFeeSettings,
	INVALID_SERVICE_FEE_CODE,
	readServiceFeePolicy,
	SERVICE_FEE_CHANGED_CODE,
	SERVICE_FEE_CONTRACT_VERSION,
	SERVICE_FEE_UNAVAILABLE_CODE,
	serviceFeeSettingsSchema,
	type ServiceFeePolicy,
	type ServiceFeeResult,
	type ServiceFeeSettings,
} from './service-fee.ts'

export {
	computePromisedTime,
	isLargeOrder,
	largeOrderExtraMinutes,
	largeOrderRuleSchema,
	MAX_PROMISED_DELAY_MINUTES,
	planPromisedDelay,
	PROMISED_DELAY_CHOICES,
	PROMISED_DELAY_NOTIFY_MINUTES,
	PROMISED_DELAY_STATUSES,
	promisedDelayMinutesSchema,
	readLargeOrderRule,
	type LargeOrderRule,
	type PromisedDelayMinutes,
	type PromisedDelayRefusal,
	type PromisedTime,
} from './promised-time.ts'

export {
	acceptanceDeadline,
	DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
	GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES,
	GUEST_CANCEL_MINUTES_CHOICES,
	GUEST_CANCEL_REFUSAL_REASONS,
	GUEST_VISIBLE_CANCEL_REASONS,
	guestCancelPolicySchema,
	guestCancelResponseSchema,
	guestCancelWindow,
	guestVisibleCancelReason,
	ORDER_ACCEPTANCE_AUTO,
	ORDER_ACCEPTANCE_MODES,
	ORDER_ACCEPTANCE_SCHEDULED_BUFFER_MINUTES,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
	ORDER_CANCEL_REASONS,
	ORDER_CANCELLED_BY_VALUES,
	ORDER_REJECT_REASONS,
	ORDER_STORED_CANCEL_REASONS,
	ORDER_SYSTEM_CANCEL_REASONS,
	orderAcceptancePolicySchema,
	orderCancelReasonSchema,
	orderNeedsAcceptance,
	orderRejectReasonSchema,
	publicOrderLifecycleSchema,
	readGuestCancelPolicy,
	readOrderAcceptancePolicy,
	readStoredCancelReason,
	type GuestCancelContext,
	type GuestCancelMinutes,
	type GuestCancelPolicy,
	type GuestCancelRefusalReason,
	type GuestCancelResponse,
	type GuestCancelWindow,
	type GuestCancelWindowInput,
	type GuestVisibleCancelReason,
	type OrderAcceptanceContext,
	type OrderAcceptanceMode,
	type OrderAcceptancePolicy,
	type OrderAcceptanceTimeoutMinutes,
	type OrderCancelledBy,
	type OrderCancelReason,
	type OrderRejectReason,
	type OrderStoredCancelReason,
	type OrderSystemCancelReason,
	type PublicOrderLifecycle,
} from './order-lifecycle.ts'

export {
	disputeBlocksRefund,
	effectiveRefundRow,
	ORDER_DISPUTE_STATUSES,
	ORDER_PAYMENT_PROCESSORS,
	ORDER_REFUND_ERROR_CODES,
	ORDER_REFUND_KINDS,
	ORDER_REFUND_MAX_LOCATION_IDS,
	ORDER_REFUND_ORIGINS,
	ORDER_REFUND_STATUSES,
	ORDER_REFUND_SUMMARY_STATUSES,
	operatorOrderRefundSchema,
	orderDisputeStatusRequestSchema,
	orderDisputeStatusResponseSchema,
	orderProviderRefundRequestSchema,
	orderProviderRefundSchema,
	orderRefundActorSchema,
	orderRefundExecuteRequestSchema,
	orderRefundIntentRequestSchema,
	orderRefundIntentResponseSchema,
	orderRefundLocationIdsSchema,
	orderRefundsPendingRequestSchema,
	orderRefundsPendingResponseSchema,
	orderRefundStatusRequestSchema,
	orderRefundStatusResponseSchema,
	refundFailureCodeSchema,
	refundIdempotencyKeySchema,
	refundNoteSchema,
	refundableAmountCents,
	refundRowReversed,
	summarizeOrderRefunds,
	type OperatorOrderRefund,
	type OrderDisputeStatus,
	type OrderDisputeStatusRequest,
	type OrderDisputeStatusResponse,
	type OrderPaymentProcessor,
	type OrderProviderRefund,
	type OrderProviderRefundRequest,
	type OrderRefundActor,
	type OrderRefundErrorCode,
	type OrderRefundExecuteRequest,
	type OrderRefundIntentRequest,
	type OrderRefundIntentResponse,
	type OrderRefundKind,
	type OrderRefundOrigin,
	type OrderRefundsPendingRequest,
	type OrderRefundsPendingResponse,
	type OrderRefundStatus,
	type OrderRefundStatusRequest,
	type OrderRefundStatusResponse,
	type OrderRefundSummary,
	type OrderRefundSummaryStatus,
} from './order-refunds.ts'

/**
 * `guestMessages` in the order context (`GET /resources/order-context`).
 * `enabled` is the organization flag `ordering.guest_messages`; `receipt`,
 * `ready` and `cancelled` are the operator's switches for those messages. Out
 * for delivery and a changed time have no switch and follow `enabled`. No PII.
 */
export const guestMessagesContextSchema = z.object({
	enabled: z.boolean(),
	receipt: z.boolean(),
	ready: z.boolean(),
	cancelled: z.boolean(),
})

export type GuestMessagesContext = z.infer<typeof guestMessagesContextSchema>

export const GUEST_MESSAGES_OFF: GuestMessagesContext = Object.freeze({
	enabled: false,
	receipt: false,
	ready: false,
	cancelled: false,
})

/** Fails closed: anything missing or malformed reads as everything off. */
export function readGuestMessagesPolicy(value: unknown): GuestMessagesContext {
	const parsed = guestMessagesContextSchema.safeParse(value)
	if (!parsed.success || !parsed.data.enabled) return { ...GUEST_MESSAGES_OFF }
	return {
		enabled: true,
		receipt: parsed.data.receipt,
		ready: parsed.data.ready,
		cancelled: parsed.data.cancelled,
	}
}
export type DropInventoryOverride = NonNullable<
	RestaurantOrderContext['drop']
>['inventoryOverrides'][number]
export type DropPickupWindowContext = NonNullable<
	RestaurantOrderContext['drop']
>['pickupWindows'][number]

// ---------------------------------------------------------------------------
// Priced order output types (stored verbatim as the order's `lines` JSON)
// ---------------------------------------------------------------------------

export type PricedOptionLine = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	/** Localized kitchen name. Guest views keep `optionName`. */
	kitchenName?: string
	kitchenHighlight?: string
	half: 'whole' | 'left' | 'right' | null
	quantity: number
	priceCents: number
	totalCents: number
}

export type PricedOrderLine = {
	itemId: string
	itemName: string
	/** Localized kitchen name. Guest views keep `itemName`. */
	kitchenName?: string
	kitchenHighlight?: string
	variantId: string | null
	quantity: number
	unitPriceCents: number
	taxableUnitCents: number
	totalCents: number
	taxableCents: number
	instructions: string | null
	options: PricedOptionLine[]
	/**
	 * One unit of the chosen variant without modifiers, and every menu category
	 * the item was in, when the order was priced. Loyalty reads them (free-item
	 * rewards, category earning).
	 */
	baseUnitCents: number
	categoryIds: string[]
	/** Set (true) only when the item or variant never receives a discount. */
	excludeFromDiscounts?: boolean
	/**
	 * The names of the variant chosen ("Large", "Thin"), for display (each may
	 * be a JSON language map). Missing on a line with no variant.
	 */
	variantNames?: string[]
	/**
	 * The variant chosen by group and value name ("Size" / "Large"), so a
	 * discount can be limited to some variants across items.
	 */
	variantChoices?: Array<{ group: string; value: string }>
}

export type OrderCapacityEntitySpec = {
	kind: 'item' | 'category'
	entityId: string
	quantity: number
	inventory: number | null
	maxPerPickupSlot: number | null
}

export type OrderCapacitySpec = {
	/** Drop these caps belong to; aggregate counts never leak across drops. */
	dropId: string
	windowId: string
	slotTime: string
	maxOrdersPerSlot: number | null
	entities: OrderCapacityEntitySpec[]
}

export type PricedRestaurantOrder = {
	currency: string
	lines: PricedOrderLine[]
	subtotalCents: number
	/**
	 * Tax on the order. When `taxInclusive` is true it is the portion already
	 * contained in `subtotalCents` and is not added to `totalCents`.
	 */
	taxCents: number
	/** True when menu prices include tax (VAT-inclusive pricing). */
	taxInclusive: boolean
	/** The location tax rate (percent) `taxCents` was computed with. */
	taxRatePercent: number
	tipCents: number
	/** Null for an exact amount the guest typed. */
	tipPercent: number | null
	deliveryFeeCents: number
	/**
	 * The guest service fee (#123), before its tax; 0 when none applies. Its
	 * tax is part of `taxCents` (and of `totalCents` when prices exclude tax).
	 */
	serviceFeeCents: number
	/** The part of `taxCents` that is on the fee. */
	serviceFeeTaxCents: number
	/** The name guests saw for the fee; null when there is none. */
	serviceFeeLabel: string | null
	/**
	 * What `applyOrderDiscounts` re-prices the fee with once discounts are
	 * known; null when no fee applies to this order.
	 */
	serviceFeeRule: {
		settings: ServiceFeeSettings
		fulfillment: ServiceFeeFulfillment
	} | null
	packagingFeeCents: number
	packagingFeeTaxCents: number
	packagingFeeLabel: string | null
	packagingFeeRule: {
		settings: PackagingFeeSettings
		fulfillment: PackagingFeeFulfillment
		itemUnits: number
	} | null
	totalCents: number
	location: { id: string; name: string; timezone: string }
	pickup: {
		windowId: string
		date: string
		time: string
		timezone: string
	} | null
	drop: { id: string; slug: string; title: string; menuId: string } | null
	delivery: {
		address: string
		city: string
		unit: string | null
		notes: string | null
		zoneId: string
		/** Set when coverage was verified from a signed delivery quote. */
		postalCode: string | null
		lat: number | null
		lng: number | null
	} | null
	/** Validated scheduled time (ISO UTC), null for ASAP. */
	scheduledFor: string | null
	holdMinutes: number
	capacity: OrderCapacitySpec | null
	/** Regular-menu ready-time slot (#108), null for drops/tabs or when off. */
	readySlotCapacity: ReadySlotCapacitySpec | null
}

// ---------------------------------------------------------------------------
// Delivery coverage verification (fail closed; fees come only from the zone)
// ---------------------------------------------------------------------------

export type DeliveryCoverageResult =
	| { ok: true; zone: DeliveryZoneLike }
	| { ok: false; error: RestaurantOrderError }

type DeliveryZoneContext = PublicLocationContext['deliveryZones'][number]
type DeliveryZoneLike = DeliveryZoneContext

/**
 * Coordinates + address the regional tenant-api signed into a delivery quote
 * token and has already verified (signature, expiry, org, location). The
 * pricing engine re-resolves the zone from these coordinates against the
 * fresh catalog context, so fee and minimum always reflect current zones.
 */
export type VerifiedDeliveryQuote = {
	lat: number
	lng: number
	formatted: string
	line1: string
	city: string
	postalCode: string | null
	unit: string | null
}

const US_ZIP_REGEX = /\b(\d{5})(?:-\d{4})?\b/g
const CA_POSTAL_REGEX = /\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/g
const FIVE_DIGIT_REGEX = /(?<!\d)(\d{5})(?!\d)/g

function lastMatch(regex: RegExp, text: string): RegExpExecArray | null {
	let found: RegExpExecArray | null = null
	let match: RegExpExecArray | null
	regex.lastIndex = 0
	while ((match = regex.exec(text)) !== null) found = match
	return found
}

/**
 * ISO country for a location: the address country when present, otherwise
 * inferred from the location currency (SAR → SA, CAD → CA, USD → US).
 */
export function locationCountryCode(
	location: Pick<PublicLocationContext, 'currency' | 'address'>,
): string {
	const raw = (location.address?.country ?? '').trim().toUpperCase()
	if (['SA', 'SAU', 'SAUDI ARABIA', 'KSA'].includes(raw)) return 'SA'
	if (['CA', 'CAN', 'CANADA'].includes(raw)) return 'CA'
	if (
		['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(raw)
	) {
		return 'US'
	}
	if (/^[A-Z]{2}$/.test(raw)) return raw
	if (location.currency === 'SAR') return 'SA'
	if (location.currency === 'CAD') return 'CA'
	return 'US'
}

/**
 * Extracts a verifiable postal code from freeform delivery text. Country
 * aware: Saudi postcodes are 5 digits (Arabic-Indic digits accepted; 4-digit
 * building / additional numbers are ignored), Canada uses A1A 1A1, and the US
 * uses ZIP / ZIP+4. Without a country, US then Canadian formats are tried.
 */
export function extractPostalCode(
	text: string,
	country?: string | null,
): string | null {
	const normalized = toAsciiDigits(text)
	const code = (country ?? '').toUpperCase()
	if (code === 'SA') {
		const match = lastMatch(FIVE_DIGIT_REGEX, normalized)
		return match ? match[1]! : null
	}
	if (code === 'CA') {
		const match = lastMatch(CA_POSTAL_REGEX, normalized)
		return match ? `${match[1]!}${match[2]!}`.toUpperCase() : null
	}
	const usMatch = lastMatch(US_ZIP_REGEX, normalized)
	if (usMatch) return usMatch[1]!
	if (code === 'US') return null
	const caMatch = lastMatch(CA_POSTAL_REGEX, normalized)
	if (caMatch) return `${caMatch[1]!}${caMatch[2]!}`.toUpperCase()
	return null
}

/**
 * Zones that participate in coverage: allowed zones must be in-house (the
 * only provider this engine can fulfil and price); disallowed zones of any
 * provider act as exclusions.
 */
function coverageZones(
	location: Pick<PublicLocationContext, 'deliveryZones'>,
): DeliveryZoneContext[] {
	return (location.deliveryZones ?? []).filter(
		(zone) =>
			zone.enabled &&
			(zone.restriction === 'disallowed' || zone.provider === 'in_house'),
	)
}

function isCheckableZone(
	zone: DeliveryZoneContext,
	location: Pick<PublicLocationContext, 'address'>,
	options: { geocoderAvailable: boolean },
): boolean {
	if (zone.type === 'zip_code') return zone.zipCodes.length > 0
	if (!options.geocoderAvailable) return false
	if (zone.type === 'polygon') return zone.polygon.length >= 3
	return (zone.radius?.value ?? 0) > 0 && hasRealCoordinates(location.address)
}

/**
 * True only when some enabled, allowed, in-house zone can actually be checked
 * server-side: zip-code zones always; radius zones need a geocoder and real
 * store coordinates; polygon zones need a geocoder.
 */
export function deliveryCoverageVerifiable(
	location: Pick<PublicLocationContext, 'deliveryZones' | 'address'>,
	options: { geocoderAvailable?: boolean } = {},
): boolean {
	const geocoderAvailable = options.geocoderAvailable ?? false
	return (location.deliveryZones ?? []).some(
		(zone) =>
			zone.enabled &&
			zone.restriction === 'allowed' &&
			zone.provider === 'in_house' &&
			isCheckableZone(zone, location, { geocoderAvailable }),
	)
}

export type DeliveryZoneForPointResult =
	| { ok: true; zone: DeliveryZoneContext }
	| { ok: false; reason: CoverageFailureReason }

/**
 * Resolves the in-house zone covering a geocoded point (radius from the store
 * address, polygon, zip; disallowed zones exclude; cheapest match wins).
 */
export function resolveDeliveryZoneForPoint(
	location: Pick<PublicLocationContext, 'deliveryZones' | 'address'>,
	point: { lat: number; lng: number; postalCode?: string | null },
): DeliveryZoneForPointResult {
	return resolveZoneForPoint(
		{
			address: location.address ?? null,
			deliveryZones: coverageZones(location),
		},
		point,
	)
}

function coverageFailure(reason: CoverageFailureReason): {
	ok: false
	error: RestaurantOrderError
} {
	if (reason === 'out_of_range' || reason === 'excluded') {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_coverage_unverified',
				message:
					'Delivery is not available for this address. Please choose pickup instead.',
			},
		}
	}
	return {
		ok: false,
		error: {
			status: 422,
			code: 'delivery_unavailable',
			message: 'Delivery is not available at this location.',
		},
	}
}

/**
 * Coverage for an order. With a verified quote the zone is re-resolved from
 * the signed coordinates against the current zones. Without one only
 * zip-code zones can be checked (from the postal code in the free text,
 * parsed for the location's country); anything else fails closed.
 */
export function resolveDeliveryCoverage(
	location: Pick<
		PublicLocationContext,
		| 'fulfillmentOptions'
		| 'deliveryZones'
		| 'deliveryConfig'
		| 'address'
		| 'currency'
	>,
	delivery: { address?: string | null; city?: string | null },
	quote: VerifiedDeliveryQuote | null = null,
): DeliveryCoverageResult {
	if (!location.fulfillmentOptions.delivery) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_disabled',
				message: 'Delivery is not available at this location.',
			},
		}
	}
	const zones = coverageZones(location)
	if (!zones.some((zone) => zone.restriction === 'allowed')) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_unavailable',
				message: 'Delivery is not available at this location.',
			},
		}
	}

	if (quote) {
		const resolved = resolveDeliveryZoneForPoint(location, quote)
		return resolved.ok ? resolved : coverageFailure(resolved.reason)
	}

	const postal = extractPostalCode(
		`${delivery.address ?? ''} ${delivery.city ?? ''}`,
		locationCountryCode(location),
	)
	if (!postal) {
		return {
			ok: false,
			error: {
				status: 422,
				code: 'delivery_coverage_unverified',
				message:
					'We could not verify delivery coverage for this address. Confirm your address or choose pickup.',
			},
		}
	}
	const normalized = normalizePostalCode(postal)
	const zipZones = zones.filter((zone) => zone.type === 'zip_code')
	const inZip = (zone: DeliveryZoneContext) =>
		zone.zipCodes.some((code) => normalizePostalCode(code) === normalized)
	if (
		zipZones.some((zone) => zone.restriction === 'disallowed' && inZip(zone))
	) {
		return coverageFailure('excluded')
	}
	let best: DeliveryZoneContext | null = null
	for (const zone of zipZones) {
		if (zone.restriction !== 'allowed' || !inZip(zone)) continue
		if (
			!best ||
			zone.deliveryFee < best.deliveryFee ||
			(zone.deliveryFee === best.deliveryFee &&
				zone.minimumOrder < best.minimumOrder)
		) {
			best = zone
		}
	}
	if (!best) return coverageFailure('out_of_range')
	return { ok: true, zone: best }
}

// ---------------------------------------------------------------------------
// Scheduled orders (ASAP when absent). Validated in the location timezone.
// ---------------------------------------------------------------------------

/** Clock skew / time-in-checkout allowance below now + prep time. */
export const SCHEDULE_GRACE_MINUTES = 5

export function validateScheduledFor(
	location: Pick<
		PublicLocationContext,
		| 'scheduling'
		| 'prepTime'
		| 'timezone'
		| 'onlineHours'
		| 'storeHours'
		| 'specialHours'
		| 'orderingPause'
		| 'busyMode'
		| 'prepSchedule'
	>,
	scheduledFor: string,
	now: Date,
):
	| { ok: true; scheduledFor: Date }
	| { ok: false; error: RestaurantOrderError } {
	const fail = (message: string) => ({
		ok: false as const,
		error: {
			status: 422 as const,
			code: 'schedule_unavailable' as const,
			message,
		},
	})
	const scheduling = location.scheduling ?? DEFAULT_SCHEDULING
	if (!scheduling.scheduledOrdersEnabled) {
		return fail('Scheduled orders are not available at this location.')
	}
	const when = new Date(scheduledFor)
	if (Number.isNaN(when.getTime())) return fail('Choose a valid time.')
	const timeZone = location.timezone || 'UTC'
	const prepMinutes =
		prepMinutesAt(
			parsePrepSchedule(location.prepSchedule),
			location.prepTime ?? 15,
			now.getTime(),
			timeZone,
		) + activeBusyExtraPrepMinutes(location, now)
	const earliest =
		now.getTime() + (prepMinutes - SCHEDULE_GRACE_MINUTES) * 60 * 1000
	if (when.getTime() < earliest) {
		return fail('That time is too soon. Please choose a later time.')
	}
	const advanceDays =
		scheduling.advanceOrderDays ?? DEFAULT_SCHEDULING.advanceOrderDays
	if (when.getTime() > now.getTime() + advanceDays * 24 * 60 * 60 * 1000) {
		return fail(`Orders can be scheduled up to ${advanceDays} days in advance.`)
	}
	const availability = isLocationOpenForOrdering(location, when)
	if (availability.paused) {
		return fail('Online ordering is paused at that time.')
	}
	if (!availability.isOpen) {
		return fail('The restaurant is not taking orders at that time.')
	}
	return { ok: true, scheduledFor: when }
}

// ---------------------------------------------------------------------------
// Catalog resolution (published catalog membership, availability, overrides)
// ---------------------------------------------------------------------------

type EntityOverride = {
	isEnabled: boolean | null
	price: number | null
	availabilityStatus: string | null
}

function overrideFor(
	overrides: LocationOverride[] | undefined,
	entityId: string,
) {
	return overrides?.find((override) => override.entityId === entityId)
}

function entityOverride(
	overrides: LocationOverride[] | undefined,
	entityId: string,
): EntityOverride | null {
	const found = overrideFor(overrides, entityId)
	if (!found) return null
	return {
		isEnabled: found.isEnabled ?? null,
		price: found.price ?? null,
		availabilityStatus: found.availabilityStatus ?? null,
	}
}

function optionEffectiveStatus(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
): string {
	const override = entityOverride(overrides, option.id)
	return override?.availabilityStatus ?? option.availabilityStatus
}

function optionPriceCents(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
	orderType: MenuOrderType | null,
	half?: 'whole' | 'left' | 'right' | null,
): number {
	const override = entityOverride(overrides, option.id)
	// #412: a fixed location price, else this order type's price, else base.
	const base = resolveMenuOptionPrice(
		orderType ? option : { price: option.price },
		{ orderType: orderType ?? 'pickup' },
		{ overridePrice: override?.price },
	)
	if (!half || half === 'whole') {
		return dollarsToCents(option.priceWhole ?? base)
	}
	if (half === 'left') return dollarsToCents(option.priceLeft ?? base)
	return dollarsToCents(option.priceRight ?? base)
}

function optionDisabled(
	option: PublicMenuOptionContext,
	overrides: LocationOverride[] | undefined,
): boolean {
	const override = entityOverride(overrides, option.id)
	return override?.isEnabled === false
}

type CatalogEntry = {
	item: PublicMenuItemContext
	categoryIds: string[]
	/** The location's override price for the dish (wins when above zero). */
	overridePrice?: number | null
	/** Drops keep their own published prices: no order-type price, no rule. */
	plainPricing?: boolean
	specialInstructions: boolean
}

type ResolvedCatalog = Map<string, CatalogEntry>

function collectMenuCategories(
	categories: PublicMenuCategoryContext[],
	overrides: LocationOverride[] | undefined,
	visit: (category: PublicMenuCategoryContext, channelAllowed: boolean) => void,
	channel?: MenuChannel,
	parentAllowed = true,
): void {
	for (const category of categories) {
		const override = entityOverride(overrides, category.id)
		if (override?.isEnabled === false) continue
		const status = override?.availabilityStatus ?? category.availabilityStatus
		if (status !== 'available') continue
		const rawOverride = channel
			? overrideFor(overrides, category.id)
			: undefined
		const categoryAllowed =
			parentAllowed &&
			(!channel || isSoldOn(channel, { category, override: rawOverride }))
		visit(category, categoryAllowed)
		if (category.subcategories?.length) {
			collectMenuCategories(
				category.subcategories,
				overrides,
				visit,
				channel,
				categoryAllowed,
			)
		}
	}
}

function findNestedGroup(
	groups: PublicModifierGroupContext[],
	groupId: string,
): PublicModifierGroupContext | null {
	for (const group of groups) {
		if (group.id === groupId) return group
		for (const option of group.options ?? []) {
			const nested = option.nestedModifierGroups
			if (!nested?.length) continue
			const found = findNestedGroup(nested, groupId)
			if (found) return found
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Modifier validation + pricing
// ---------------------------------------------------------------------------

type ResolvedSelection = {
	group: PublicModifierGroupContext
	option: PublicMenuOptionContext
	half: 'whole' | 'left' | 'right' | null
	quantity: number
}

type ModifierResult =
	| {
			ok: true
			options: PricedOptionLine[]
			optionCents: number
			taxableCents: number
	  }
	| { ok: false; error: RestaurantOrderError }

function kitchenFields(entity: object): {
	kitchenName?: string
	kitchenHighlight?: string
} {
	const record = entity as {
		kitchenName?: unknown
		kitchenHighlight?: unknown
	}
	const kitchenName =
		typeof record.kitchenName === 'string' && record.kitchenName
			? record.kitchenName
			: undefined
	const kitchenHighlight =
		record.kitchenHighlight === 'none' ||
		record.kitchenHighlight === 'allergy' ||
		record.kitchenHighlight === 'attention' ||
		record.kitchenHighlight === 'long_prep'
			? record.kitchenHighlight
			: undefined
	return {
		...(kitchenName ? { kitchenName } : {}),
		...(kitchenHighlight ? { kitchenHighlight } : {}),
	}
}

function priceModifierSelections(
	item: PublicMenuItemContext,
	selections: Array<{
		groupId: string
		optionId: string
		half?: 'whole' | 'left' | 'right'
		quantity?: number
	}>,
	overrides: LocationOverride[] | undefined,
	/** Null: published prices only (drops). */
	orderType: MenuOrderType | null,
): ModifierResult {
	const fail = (error: RestaurantOrderError): ModifierResult => ({
		ok: false,
		error,
	})

	// Groups currently offered: the item's direct available groups, plus nested
	// groups unlocked by selecting their parent option.
	const allowedGroups = new Map<string, PublicModifierGroupContext>()
	for (const group of item.modifierGroups ?? []) {
		if (group.availabilityStatus !== 'available') continue
		allowedGroups.set(group.id, group)
	}

	const pending = selections.map((selection) => ({
		...selection,
		half: selection.half ?? null,
		quantity: selection.quantity ?? null,
	}))
	const resolved: ResolvedSelection[] = []

	let passes = 0
	while (pending.length > 0) {
		if (passes++ > MAX_MODIFIER_FIXPOINT_PASSES) {
			return fail({
				status: 400,
				code: 'unknown_modifier_group',
				message: 'That choice is not available for this item.',
			})
		}
		let progressed = false
		for (let index = pending.length - 1; index >= 0; index -= 1) {
			const selection = pending[index]!
			const group = allowedGroups.get(selection.groupId)
			if (!group) continue
			const option = (group.options ?? []).find(
				(candidate) => candidate.id === selection.optionId,
			)
			if (!option) {
				return fail({
					status: 400,
					code: 'unknown_option',
					message: `That choice is not available for ${group.name}.`,
				})
			}
			if (optionDisabled(option, overrides)) {
				return fail({
					status: 400,
					code: 'option_unavailable',
					message: `${option.displayName} is not available.`,
				})
			}
			if (optionEffectiveStatus(option, overrides) !== 'available') {
				return fail({
					status: 400,
					code: 'option_unavailable',
					message: `${option.displayName} is not available.`,
				})
			}
			// Half is only meaningful for pizza groups.
			if (selection.half && group.selectionType !== 'pizza') {
				return fail({
					status: 400,
					code: 'invalid_half',
					message: `Half selections are not valid for ${group.name}.`,
				})
			}
			// Quantity is only meaningful for quantity groups.
			if (
				selection.quantity != null &&
				group.selectionType !== 'quantity' &&
				selection.quantity !== 1
			) {
				return fail({
					status: 400,
					code: 'invalid_quantity',
					message: `Quantities are not valid for ${group.name}.`,
				})
			}
			resolved.push({
				group,
				option,
				half:
					group.selectionType === 'pizza' ? (selection.half ?? 'whole') : null,
				quantity: selection.quantity ?? 1,
			})
			// Unlock this option's nested modifier groups.
			const nestedIds = option.nestedModifierGroupIds ?? []
			const attachedNested = option.nestedModifierGroups ?? []
			for (const nestedId of nestedIds) {
				if (allowedGroups.has(nestedId)) continue
				const nested =
					attachedNested.find((candidate) => candidate.id === nestedId) ??
					findNestedGroup(item.modifierGroups ?? [], nestedId)
				if (nested && nested.availabilityStatus === 'available') {
					allowedGroups.set(nestedId, nested)
				}
			}
			for (const nested of attachedNested) {
				if (
					!allowedGroups.has(nested.id) &&
					nested.availabilityStatus === 'available'
				) {
					allowedGroups.set(nested.id, nested)
				}
			}
			pending.splice(index, 1)
			progressed = true
		}
		if (!progressed) {
			const selection = pending[0]!
			const hasGroup = (item.modifierGroups ?? []).some(
				(group) => group.id === selection.groupId,
			)
			return fail({
				status: 400,
				code: hasGroup ? 'option_unavailable' : 'unknown_modifier_group',
				message: 'That choice is not available for this item.',
			})
		}
	}

	// Aggregate per group and enforce selection rules.
	const byGroup = new Map<string, ResolvedSelection[]>()
	for (const selection of resolved) {
		const list = byGroup.get(selection.group.id) ?? []
		list.push(selection)
		byGroup.set(selection.group.id, list)
	}

	const pricedOptions: PricedOptionLine[] = []
	let optionCents = 0
	let taxableCents = 0

	for (const [groupId, selections] of byGroup) {
		const group = allowedGroups.get(groupId)!
		const type = group.selectionType
		const min = group.minSelections ?? 0
		const max = group.maxSelections ?? null

		if (type === 'single' || type === 'multiple') {
			const distinctIds = new Set(
				selections.map((selection) => selection.option.id),
			)
			if (distinctIds.size !== selections.length) {
				return fail({
					status: 400,
					code: 'duplicate_option',
					message: `${group.name} cannot contain the same choice twice.`,
				})
			}
			const effectiveMax =
				max ?? (type === 'single' ? 1 : Number.POSITIVE_INFINITY)
			if (selections.length < min) {
				return fail({
					status: 400,
					code: 'required_modifier',
					message:
						min === 1
							? `Please choose ${group.name}.`
							: `${group.name}: choose at least ${min} options.`,
				})
			}
			if (selections.length > effectiveMax) {
				return fail({
					status: 400,
					code: 'modifier_limit',
					message: `${group.name}: choose at most ${effectiveMax} options.`,
				})
			}
			for (const selection of selections) {
				const priceCents = optionPriceCents(
					selection.option,
					overrides,
					orderType,
				)
				optionCents += priceCents
				if (selection.option.applySalesTax !== false) taxableCents += priceCents
				pricedOptions.push({
					groupId,
					groupName: group.name,
					optionId: selection.option.id,
					optionName: selection.option.displayName,
					...kitchenFields(selection.option),
					half: null,
					quantity: 1,
					priceCents,
					totalCents: priceCents,
				})
			}
			continue
		}

		if (type === 'quantity') {
			let totalQuantity = 0
			for (const selection of selections) {
				const quantity = selection.quantity ?? 1
				const optionMax =
					selection.option.maxSelections ?? max ?? RESTAURANT_MAX_LINE_QUANTITY
				if (quantity < 1) {
					return fail({
						status: 400,
						code: 'invalid_quantity',
						message: `${group.name}: choose at least one.`,
					})
				}
				if (quantity > optionMax) {
					return fail({
						status: 400,
						code: 'option_quantity_limit',
						message: `${selection.option.displayName}: maximum ${optionMax}.`,
					})
				}
				totalQuantity += quantity
			}
			if (totalQuantity < min) {
				return fail({
					status: 400,
					code: 'required_modifier',
					message:
						min === 1
							? `Please choose ${group.name}.`
							: `${group.name}: choose at least ${min}.`,
				})
			}
			if (max != null && totalQuantity > max) {
				return fail({
					status: 400,
					code: 'modifier_limit',
					message: `${group.name}: choose at most ${max}.`,
				})
			}
			for (const selection of selections) {
				const quantity = selection.quantity ?? 1
				const priceCents = optionPriceCents(
					selection.option,
					overrides,
					orderType,
				)
				const total = priceCents * quantity
				optionCents += total
				if (selection.option.applySalesTax !== false) taxableCents += total
				pricedOptions.push({
					groupId,
					groupName: group.name,
					optionId: selection.option.id,
					optionName: selection.option.displayName,
					...kitchenFields(selection.option),
					half: null,
					quantity,
					priceCents,
					totalCents: total,
				})
			}
			continue
		}

		// pizza
		const seen = new Set<string>()
		const optionHalves = new Map<string, Set<string>>()
		for (const selection of selections) {
			const key = `${selection.option.id}::${selection.half ?? 'whole'}`
			if (seen.has(key)) {
				return fail({
					status: 400,
					code: 'duplicate_option',
					message: `${group.name} cannot contain the same choice twice.`,
				})
			}
			seen.add(key)
			const halves = optionHalves.get(selection.option.id) ?? new Set<string>()
			halves.add(selection.half ?? 'whole')
			optionHalves.set(selection.option.id, halves)
		}
		for (const [optionId, halves] of optionHalves) {
			if (halves.has('whole') && halves.size > 1) {
				return fail({
					status: 400,
					code: 'invalid_combination',
					message: `${group.name}: whole and half choices cannot be combined.`,
				})
			}
			if (halves.has('left') && halves.has('right')) {
				// left + right of the same option is a valid "split" selection.
			}
			void optionId
		}
		const effectiveMax = max ?? Number.POSITIVE_INFINITY
		if (selections.length < min) {
			return fail({
				status: 400,
				code: 'required_modifier',
				message:
					min === 1
						? `Please choose ${group.name}.`
						: `${group.name}: choose at least ${min}.`,
			})
		}
		if (selections.length > effectiveMax) {
			return fail({
				status: 400,
				code: 'modifier_limit',
				message: `${group.name}: choose at most ${effectiveMax}.`,
			})
		}
		for (const selection of selections) {
			const half = selection.half ?? 'whole'
			const priceCents = optionPriceCents(
				selection.option,
				overrides,
				orderType,
				half,
			)
			optionCents += priceCents
			if (selection.option.applySalesTax !== false) taxableCents += priceCents
			pricedOptions.push({
				groupId,
				groupName: group.name,
				optionId: selection.option.id,
				optionName: selection.option.displayName,
				...kitchenFields(selection.option),
				half,
				quantity: 1,
				priceCents,
				totalCents: priceCents,
			})
		}
	}

	// Every offered group must satisfy its minimum. Groups that were never
	// offered (nested under an unselected option) impose nothing.
	for (const group of allowedGroups.values()) {
		const selections = byGroup.get(group.id) ?? []
		const satisfied =
			group.selectionType === 'quantity'
				? selections.reduce(
						(sum, selection) => sum + (selection.quantity ?? 1),
						0,
					)
				: selections.length
		if ((group.minSelections ?? 0) > satisfied) {
			const min = group.minSelections ?? 0
			return fail({
				status: 400,
				code: 'required_modifier',
				message:
					min === 1
						? `Please choose ${group.name}.`
						: `${group.name}: choose at least ${min}.`,
			})
		}
	}

	return { ok: true, options: pricedOptions, optionCents, taxableCents }
}

// ---------------------------------------------------------------------------
// Repricing engine
// ---------------------------------------------------------------------------

function orderError(
	status: RestaurantOrderError['status'],
	code: RestaurantOrderErrorCode,
	message: string,
	details?: Record<string, unknown>,
): RestaurantOrderError {
	return details
		? { status, code, message, details }
		: { status, code, message }
}

/**
 * Re-derives every cent and every constraint from authoritative catalog data.
 * No browser price, membership, or availability input is trusted.
 */
export function priceRestaurantOrder(
	context: RestaurantOrderContext,
	request: RestaurantOrderQuoteRequest,
	options: {
		now: Date
		/** Verified signed delivery quote (tenant-api checks signature/expiry). */
		deliveryQuote?: VerifiedDeliveryQuote | null
		/**
		 * Price an order rung up in the restaurant (POS) rather than placed
		 * online. Only the online-ordering gates are skipped (open hours, the
		 * pickup switch, in-house tip rules, the menu's special-instructions
		 * setting); every catalog, variant and modifier rule still applies. The
		 * caller's `request` must be a plain pickup order with no drop.
		 */
		walkIn?: boolean
		/**
		 * Price as this order type (#412) instead of the request's fulfillment:
		 * the till review sends its own order type (dine-in, or takeaway and
		 * drive-through as pickup).
		 */
		priceAs?: MenuOrderType
		/**
		 * Ordering channel (#220): items/categories/menus not sold on this
		 * channel are treated as missing from the catalog and return HTTP 409
		 * `item_unavailable`.
		 */
		channel?: MenuChannel
	},
): PriceRestaurantOrderResult {
	const { now, channel } = options
	const walkIn = options.walkIn === true
	const deliveryQuote = options.deliveryQuote ?? null

	const location = context.menu.locations.find(
		(candidate) => candidate.id === request.locationId,
	)
	if (!location) {
		return {
			ok: false,
			error: orderError(
				404,
				'location_not_found',
				'This location is not available for ordering.',
			),
		}
	}

	// Tab and QR table rounds are dine-in; the till passes its own type.
	const priceContext = {
		orderType: options.priceAs ?? menuOrderTypeFor(request.fulfillment),
		locationId: location.id,
		rules: parseMenuPricingRules(context.menu.pricingRules),
		now,
	}

	const dropSlug = request.dropSlug ?? null
	if (dropSlug && !request.pickup) {
		return {
			ok: false,
			error: orderError(400, 'pickup_required', 'Choose a pickup time.'),
		}
	}
	if (!dropSlug && request.pickup) {
		return {
			ok: false,
			error: orderError(
				400,
				'pickup_not_supported',
				'Pickup windows are only available for drops.',
			),
		}
	}
	if (request.fulfillment === 'delivery' && !request.delivery) {
		return {
			ok: false,
			error: orderError(
				400,
				'delivery_address_required',
				'A delivery address is required.',
			),
		}
	}
	if (request.fulfillment !== 'delivery' && request.delivery) {
		return {
			ok: false,
			error: orderError(
				400,
				'delivery_not_allowed',
				'Delivery details are not valid for pickup orders.',
			),
		}
	}
	if (request.fulfillment === 'dine_in') {
		if (
			walkIn ||
			dropSlug ||
			request.scheduledFor ||
			requestsTip(request) ||
			request.paymentMethod !== 'handoff'
		) {
			return {
				ok: false,
				error: orderError(
					400,
					'dine_in_not_allowed',
					'This order cannot be placed at the table.',
				),
			}
		}
		if (!location.fulfillmentOptions.dineIn) {
			return {
				ok: false,
				error: orderError(
					422,
					'dine_in_disabled',
					'Ordering at the table is not available at this location.',
				),
			}
		}
	}
	if (
		!walkIn &&
		request.fulfillment === 'pickup' &&
		!location.fulfillmentOptions.pickup
	) {
		return {
			ok: false,
			error: orderError(
				422,
				'pickup_disabled',
				'Pickup is not available at this location.',
			),
		}
	}
	if (
		request.fulfillment === 'delivery' &&
		!location.fulfillmentOptions.delivery
	) {
		return {
			ok: false,
			error: orderError(
				422,
				'delivery_disabled',
				'Delivery is not available at this location.',
			),
		}
	}
	const tipsEnabled =
		request.fulfillment === 'pickup'
			? location.inHouseTips.pickupTips
			: location.inHouseTips.deliveryTips
	if (!walkIn && requestsTip(request) && !tipsEnabled) {
		return {
			ok: false,
			error: orderError(
				422,
				'tips_disabled',
				'Tips are not accepted for this order.',
			),
		}
	}

	// ---- Catalog + drop resolution ------------------------------------------
	const locationOverrides = dropSlug
		? undefined
		: (context.menu.locationOverrides?.[location.id] ?? undefined)
	const catalog: ResolvedCatalog = new Map()
	const channelHiddenItemIds = new Set<string>()
	const categoryExempt = new Set<string>()
	let dropInfo: PricedRestaurantOrder['drop'] = null
	let pickupInfo: PricedRestaurantOrder['pickup'] = null
	let holdMinutes = RESTAURANT_ONLINE_HOLD_MINUTES
	let capacity: OrderCapacitySpec | null = null
	let inventoryOverrides: DropInventoryOverride[] = []
	const itemRules = new Map<string, DropInventoryOverride>()
	const categoryRules = new Map<string, DropInventoryOverride>()
	let currency: string = location.currency || context.menu.organization.currency
	let scheduledFor: string | null = null
	if (dropSlug && request.scheduledFor) {
		return {
			ok: false,
			error: orderError(
				422,
				'schedule_unavailable',
				'Drops use pickup windows instead of scheduled times.',
			),
		}
	}

	if (dropSlug) {
		const dropData = context.drop
		if (
			!dropData ||
			dropData.drop.slug.toLowerCase() !== dropSlug.toLowerCase()
		) {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		if (dropData.drop.status === 'draft') {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		const displayStatus = getDropDisplayStatus(
			dropData.drop.status as
				'draft' | 'scheduled' | 'live' | 'closed' | 'completed',
			dropData.drop.ordersOpenAt ?? null,
			dropData.drop.ordersCloseAt ?? null,
			now,
		)
		if (displayStatus !== 'live') {
			return {
				ok: false,
				error: orderError(
					422,
					'drop_closed',
					'Orders are closed for this drop.',
				),
			}
		}
		const pickup = request.pickup!
		const window = dropData.pickupWindows.find(
			(candidate) => candidate.id === pickup.windowId,
		)
		if (!window || window.locationId !== location.id) {
			return {
				ok: false,
				error: orderError(
					400,
					'invalid_pickup_window',
					'Choose a valid pickup window.',
				),
			}
		}
		// Regenerate slots exactly; never trust a possibly stale slot list.
		const slots = generatePickupSlots(
			window.startTime,
			window.endTime,
			window.slotIntervalMinutes,
		)
		if (!slots.some((slot) => slot.time === pickup.time)) {
			return {
				ok: false,
				error: orderError(
					400,
					'invalid_pickup_slot',
					'Choose a valid pickup time.',
				),
			}
		}
		const timezone = window.location?.timezone || location.timezone || 'UTC'
		const slotStart = localDateAndTimeToUtc(window.date, pickup.time, timezone)
		const leadTimeMs = window.orderLeadTimeMinutes * 60 * 1000
		if (slotStart.getTime() < now.getTime() + leadTimeMs) {
			return {
				ok: false,
				error: orderError(
					422,
					'lead_time',
					'That pickup time is no longer available. Please choose a later slot.',
				),
			}
		}

		holdMinutes = clampInt(
			dropData.drop.checkoutHoldMinutes,
			RESTAURANT_MIN_HOLD_MINUTES,
			RESTAURANT_MAX_HOLD_MINUTES,
			RESTAURANT_ONLINE_HOLD_MINUTES,
		)
		dropInfo = {
			id: dropData.drop.id,
			slug: dropData.drop.slug,
			title: dropData.drop.title,
			menuId: dropData.drop.menu.id,
		}
		pickupInfo = {
			windowId: window.id,
			date: window.date,
			time: pickup.time,
			timezone,
		}
		inventoryOverrides = dropData.inventoryOverrides
		for (const override of inventoryOverrides) {
			if (override.entityType === 'item')
				itemRules.set(override.entityId, override)
			else categoryRules.set(override.entityId, override)
		}

		// Published catalog membership for a drop is the drop's own categories.
		for (const category of dropData.categories) {
			if (category.availabilityStatus !== 'available') continue
			const categoryAllowed =
				!channel ||
				isSoldOn(channel, {
					menu: { channels: dropData.drop.menu.channels },
					category,
				})
			if (categoryAllowed && category.excludeFromOrderLimits === true) {
				categoryExempt.add(category.id)
			}
			for (const item of category.items ?? []) {
				if (channel && (!categoryAllowed || !isSoldOn(channel, { item }))) {
					channelHiddenItemIds.add(item.id)
					continue
				}
				const existing = catalog.get(item.id)
				const categoryIds = new Set(existing?.categoryIds ?? [])
				categoryIds.add(category.id)
				catalog.set(item.id, {
					item,
					categoryIds: [...categoryIds],
					specialInstructions: dropData.drop.menu.specialInstructions ?? true,
					plainPricing: true,
				})
			}
		}
		currency = dropData.organization.currency || currency
	} else {
		if (request.scheduledFor) {
			// Scheduled orders may be placed while closed; the chosen time must
			// fall inside online hours (validated in the location timezone).
			const schedule = validateScheduledFor(location, request.scheduledFor, now)
			if (!schedule.ok) return { ok: false, error: schedule.error }
			scheduledFor = schedule.scheduledFor.toISOString()
		} else if (!walkIn) {
			const availability = isLocationOpenForOrdering(location, now)
			if (availability.paused) {
				return {
					ok: false,
					error: orderError(
						422,
						'ordering_paused',
						'Online ordering is paused right now. Please try again later.',
					),
				}
			}
			if (!availability.isOpen) {
				return {
					ok: false,
					error: orderError(
						422,
						'ordering_closed',
						availability.reason || 'Ordering is currently closed.',
					),
				}
			}
		}
		for (const menu of context.menu.menus) {
			if (menu.menuType === 'drop' || menu.availabilityStatus !== 'available') {
				continue
			}
			const rawMenuOverride = channel
				? overrideFor(locationOverrides, menu.id)
				: undefined
			const menuAllowed =
				!channel || isSoldOn(channel, { menu, override: rawMenuOverride })
			collectMenuCategories(
				menu.categories ?? [],
				locationOverrides,
				(category, categoryAllowed) => {
					if (categoryAllowed && category.excludeFromOrderLimits === true) {
						categoryExempt.add(category.id)
					}
					for (const item of category.items ?? []) {
						const itemOverride = entityOverride(locationOverrides, item.id)
						if (itemOverride?.isEnabled === false) continue
						const status =
							itemOverride?.availabilityStatus ?? item.availabilityStatus
						if (status !== 'available') continue
						const rawItemOverride = channel
							? overrideFor(locationOverrides, item.id)
							: undefined
						if (
							channel &&
							(!categoryAllowed ||
								!isSoldOn(channel, { item, override: rawItemOverride }))
						) {
							channelHiddenItemIds.add(item.id)
							continue
						}
						const existing = catalog.get(item.id)
						const categoryIds = new Set(existing?.categoryIds ?? [])
						categoryIds.add(category.id)
						catalog.set(item.id, {
							item,
							overridePrice: itemOverride?.price ?? null,
							categoryIds: [...categoryIds],
							specialInstructions:
								menu.specialInstructions ||
								(existing?.specialInstructions ?? false),
						})
					}
				},
				channel,
				menuAllowed,
			)
		}
	}

	// ---- Line validation + repricing ----------------------------------------
	const pricedLines: PricedOrderLine[] = []
	const itemQuantityTotals = new Map<string, number>()
	const categoryQuantityTotals = new Map<string, number>()
	const capacityEntities = new Map<
		string,
		{
			kind: 'item' | 'category'
			entityId: string
			quantity: number
			inventory: number | null
			maxPerPickupSlot: number | null
		}
	>()

	for (const line of request.lines) {
		const entry = catalog.get(line.itemId)
		if (!entry) {
			if (channel && channelHiddenItemIds.has(line.itemId)) {
				return {
					ok: false,
					error: orderError(
						409,
						'item_unavailable',
						'This item is not available on this ordering channel.',
					),
				}
			}
			return {
				ok: false,
				error: orderError(
					400,
					'unknown_item',
					'Your order includes an item that is not available.',
				),
			}
		}
		if (entry.item.availabilityStatus !== 'available') {
			return {
				ok: false,
				error: orderError(
					400,
					'item_unavailable',
					`${entry.item.displayName} is not available right now.`,
				),
			}
		}
		if (line.instructions && !entry.specialInstructions && !walkIn) {
			return {
				ok: false,
				error: orderError(
					400,
					'instructions_not_allowed',
					'Special instructions are not accepted for this order.',
				),
			}
		}

		const variants = entry.item.variations?.variants ?? []
		let variant: (typeof variants)[number] | null = null
		if (variants.length > 0) {
			if (!line.variantId) {
				return {
					ok: false,
					error: orderError(
						400,
						'variant_required',
						`Choose an option for ${entry.item.displayName}.`,
					),
				}
			}
			variant =
				variants.find((candidate) => candidate.id === line.variantId) ?? null
			if (!variant) {
				return {
					ok: false,
					error: orderError(
						400,
						'unknown_variant',
						`That option for ${entry.item.displayName} is not available.`,
					),
				}
			}
			if (variant.availabilityStatus !== 'available') {
				return {
					ok: false,
					error: orderError(
						400,
						'variant_unavailable',
						`That option for ${entry.item.displayName} is not available.`,
					),
				}
			}
		} else if (line.variantId) {
			return {
				ok: false,
				error: orderError(
					400,
					'unknown_variant',
					`That option for ${entry.item.displayName} is not available.`,
				),
			}
		}

		const modifierResult = priceModifierSelections(
			entry.item,
			line.options,
			locationOverrides,
			entry.plainPricing ? null : priceContext.orderType,
		)
		if (!modifierResult.ok) return { ok: false, error: modifierResult.error }

		// #412 / #388: one resolver for every channel (see menu-pricing.ts).
		const baseCents = dollarsToCents(
			entry.plainPricing
				? variant
					? variant.price
					: entry.item.price
				: resolveMenuItemPrice(
						{
							price: entry.item.price,
							orderTypePrices: entry.item.orderTypePrices,
							categoryIds: entry.categoryIds,
						},
						priceContext,
						{
							variantPrice: variant ? variant.price : null,
							overridePrice: entry.overridePrice,
						},
					),
		)
		const unitCents = baseCents + modifierResult.optionCents
		const lineTotal = unitCents * line.quantity
		// The item's own price is taxed unless the item says otherwise (options
		// carry their own flag); a missing flag reads as taxed.
		const taxableBaseCents = entry.item.applySalesTax === false ? 0 : baseCents
		const lineTaxable =
			taxableBaseCents * line.quantity +
			modifierResult.taxableCents * line.quantity

		pricedLines.push({
			itemId: entry.item.id,
			itemName: entry.item.displayName,
			...kitchenFields(entry.item),
			variantId: variant ? variant.id : null,
			quantity: line.quantity,
			unitPriceCents: unitCents,
			taxableUnitCents: taxableBaseCents + modifierResult.taxableCents,
			totalCents: lineTotal,
			taxableCents: lineTaxable,
			instructions: line.instructions ? line.instructions : null,
			options: modifierResult.options,
			baseUnitCents: baseCents,
			categoryIds: [...entry.categoryIds],
			...(variant
				? {
						variantNames: (entry.item.variations?.groups ?? []).flatMap(
							(group) =>
								(group.values ?? [])
									.filter((value) => variant.valueIds?.includes(value.id))
									.map((value) => value.name),
						),
						variantChoices: (entry.item.variations?.groups ?? []).flatMap(
							(group) =>
								(group.values ?? [])
									.filter((value) => variant.valueIds?.includes(value.id))
									.map((value) => ({ group: group.name, value: value.name })),
						),
					}
				: {}),
			...(entry.item.excludeFromDiscounts === true ||
			variant?.excludeFromDiscounts === true
				? { excludeFromDiscounts: true }
				: {}),
		})

		itemQuantityTotals.set(
			entry.item.id,
			(itemQuantityTotals.get(entry.item.id) ?? 0) + line.quantity,
		)
		for (const categoryId of entry.categoryIds) {
			categoryQuantityTotals.set(
				categoryId,
				(categoryQuantityTotals.get(categoryId) ?? 0) + line.quantity,
			)
		}
	}

	// ---- Drop capacity rules (per-order caps checked here; aggregates in the DB tx) ----
	if (dropSlug) {
		for (const [itemId, quantity] of itemQuantityTotals) {
			const rule = itemRules.get(itemId)
			if (rule?.maxPerOrder != null && quantity > rule.maxPerOrder) {
				return {
					ok: false,
					error: orderError(
						422,
						'per_order_limit',
						`This order exceeds the limit of ${rule.maxPerOrder} per order for this item.`,
					),
				}
			}
		}
		for (const [categoryId, quantity] of categoryQuantityTotals) {
			const rule = categoryRules.get(categoryId)
			if (rule?.maxPerOrder != null && quantity > rule.maxPerOrder) {
				return {
					ok: false,
					error: orderError(
						422,
						'per_order_limit',
						`This order exceeds the limit of ${rule.maxPerOrder} per order.`,
					),
				}
			}
		}
		for (const line of pricedLines) {
			const itemRule = itemRules.get(line.itemId)
			if (
				itemRule &&
				(itemRule.inventory != null || itemRule.maxPerPickupSlot != null)
			) {
				const key = `item:${line.itemId}`
				const entity = capacityEntities.get(key) ?? {
					kind: 'item' as const,
					entityId: line.itemId,
					quantity: 0,
					inventory: itemRule.inventory ?? null,
					maxPerPickupSlot: itemRule.maxPerPickupSlot ?? null,
				}
				entity.quantity += line.quantity
				if (itemRule.inventory != null) entity.inventory = itemRule.inventory
				if (itemRule.maxPerPickupSlot != null) {
					entity.maxPerPickupSlot = itemRule.maxPerPickupSlot
				}
				capacityEntities.set(key, entity)
			}
			const entry = catalog.get(line.itemId)!
			for (const categoryId of entry.categoryIds) {
				const rule = categoryRules.get(categoryId)
				if (rule && (rule.inventory != null || rule.maxPerPickupSlot != null)) {
					const key = `category:${categoryId}`
					const entity = capacityEntities.get(key) ?? {
						kind: 'category' as const,
						entityId: categoryId,
						quantity: 0,
						inventory: rule.inventory ?? null,
						maxPerPickupSlot: rule.maxPerPickupSlot ?? null,
					}
					entity.quantity += line.quantity
					if (rule.inventory != null) entity.inventory = rule.inventory
					if (rule.maxPerPickupSlot != null) {
						entity.maxPerPickupSlot = rule.maxPerPickupSlot
					}
					capacityEntities.set(key, entity)
				}
			}
		}
		const window = context.drop!.pickupWindows.find(
			(candidate) => candidate.id === request.pickup!.windowId,
		)!
		capacity = {
			dropId: context.drop!.drop.id,
			windowId: window.id,
			slotTime: request.pickup!.time,
			maxOrdersPerSlot: window.maxOrdersPerSlot ?? null,
			entities: [...capacityEntities.values()],
		}
	}

	// ---- Delivery coverage + fee -------------------------------------------
	let deliveryInfo: PricedRestaurantOrder['delivery'] = null
	let deliveryFeeCents = 0
	if (request.fulfillment === 'delivery' && request.delivery) {
		if (request.delivery.quoteToken && !deliveryQuote) {
			return {
				ok: false,
				error: orderError(
					422,
					'delivery_quote_expired',
					'Your delivery address check has expired. Please confirm your address again.',
				),
			}
		}
		const coverage = resolveDeliveryCoverage(
			location,
			request.delivery,
			deliveryQuote,
		)
		if (!coverage.ok) return { ok: false, error: coverage.error }
		const zone = coverage.zone
		deliveryFeeCents = dollarsToCents(zone.deliveryFee)
		// With a quote, the persisted address comes from the signed payload,
		// never from client text.
		deliveryInfo = deliveryQuote
			? {
					address: deliveryQuote.formatted || deliveryQuote.line1,
					city: deliveryQuote.city,
					unit: deliveryQuote.unit || request.delivery.unit || null,
					notes: request.delivery.notes ?? null,
					zoneId: zone.id,
					postalCode: deliveryQuote.postalCode,
					lat: deliveryQuote.lat,
					lng: deliveryQuote.lng,
				}
			: {
					address: request.delivery.address ?? '',
					city: request.delivery.city ?? '',
					unit: request.delivery.unit ?? null,
					notes: request.delivery.notes ?? null,
					zoneId: zone.id,
					postalCode: null,
					lat: null,
					lng: null,
				}
	}

	// ---- Totals --------------------------------------------------------------
	const subtotalCents = pricedLines.reduce(
		(sum, line) => sum + line.totalCents,
		0,
	)
	const capSettings = readOrderCapsForLocation(context.orderCaps, location.id)
	const capViolation = checkOrderCaps({
		settings: capSettings,
		fulfillment: request.fulfillment,
		subtotalCents,
		guestCount: request.guestCount,
	})
	if (capViolation && !walkIn) {
		return {
			ok: false,
			// Says which limit was hit so the page can point to catering or the phone
			// (amount) or to a team member (a big table), never the number itself.
			error: orderError(
				422,
				ORDER_TOO_LARGE_CODE,
				capViolation.kind === 'guests'
					? 'This group is too large to order from the table. Please ask a member of the team.'
					: 'This order is too large for online checkout. Please call the restaurant or place a catering order.',
				{ kind: capViolation.kind, fulfillment: capViolation.fulfillment },
			),
		}
	}
	if (
		deliveryInfo &&
		zoneMinimumOrderCents(subtotalCents, location, deliveryInfo.zoneId)
	) {
		const zone = (location.deliveryZones ?? []).find(
			(candidate) => candidate.id === deliveryInfo!.zoneId,
		)
		return {
			ok: false,
			error: orderError(
				422,
				'minimum_order',
				`The minimum delivery order is ${minimumOrderText(zone?.minimumOrder ?? 0)}.`,
			),
		}
	}
	const taxableCents = pricedLines.reduce(
		(sum, line) => sum + line.taxableCents,
		0,
	)
	const taxRatePercent = Math.max(0, Math.min(100, location.taxRate || 0))
	const taxInclusive = location.taxInclusive === true
	const taxCents = taxInclusive
		? inclusiveTaxCents(taxableCents, taxRatePercent)
		: Math.round((taxableCents * taxRatePercent) / 100)
	const tip = computeTip({
		tip: requestedTip(request),
		subtotalCents,
		currency,
	})
	if (!tip.ok) {
		return {
			ok: false,
			error: orderError(
				422,
				TIP_TOO_LARGE_CODE,
				'That tip is more than we can accept. Please enter a smaller amount.',
			),
		}
	}
	const tipCents = tip.tipCents
	// The guest service fee: the node refuses a location whose fee it cannot
	// read instead of placing the order without it. Counter sales have none,
	// and neither does a table round: a tab pays its fee once, when it is paid
	// from the phone.
	const feePolicy =
		walkIn || request.fulfillment === 'dine_in'
			? ({ kind: 'off' } as const)
			: readServiceFeePolicy(context.serviceFee, location.id)
	if (feePolicy.kind === 'unreadable') {
		return {
			ok: false,
			error: orderError(
				503,
				'service_fee_unavailable',
				'This restaurant cannot take online orders right now. Please try again later.',
			),
		}
	}
	const serviceFeeRule =
		feePolicy.kind === 'on'
			? { settings: feePolicy.settings, fulfillment: request.fulfillment }
			: null
	// Priced before any discount here; `applyOrderDiscounts` re-prices it on
	// the discounted subtotal.
	const serviceFee = computeServiceFee({
		settings: serviceFeeRule?.settings ?? null,
		fulfillment: request.fulfillment,
		baseCents: subtotalCents,
		taxRatePercent,
		taxInclusive,
	})
	const packagingPolicy =
		walkIn || request.fulfillment === 'dine_in'
			? ({ kind: 'off' } as const)
			: readPackagingFeePolicy(context.packagingFee, location.id)
	if (packagingPolicy.kind === 'unreadable') {
		return {
			ok: false,
			error: orderError(
				503,
				PACKAGING_FEE_UNAVAILABLE_CODE,
				'This restaurant cannot take online orders right now. Please try again later.',
			),
		}
	}
	const packagingItemUnits = orderDishUnits(
		pricedLines.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			categoryIds: line.categoryIds,
		})),
		orderLimitExemptFromCatalog(catalog, categoryExempt),
	)
	const packagingFeeRule =
		packagingPolicy.kind === 'on' &&
		request.fulfillment !== 'dine_in' &&
		packagingPolicy.settings.fulfillments.includes(request.fulfillment)
			? {
					settings: packagingPolicy.settings,
					fulfillment: request.fulfillment,
					itemUnits: packagingItemUnits,
				}
			: null
	const packagingFee = computePackagingFee({
		settings: packagingFeeRule?.settings ?? null,
		fulfillment: request.fulfillment,
		itemUnits: packagingItemUnits,
		taxRatePercent,
		taxInclusive,
	})
	const orderTaxCents = taxCents + serviceFee.taxCents + packagingFee.taxCents
	// Inclusive prices already carry the tax: it is reported, not added.
	const totalCents =
		subtotalCents +
		(taxInclusive ? 0 : orderTaxCents) +
		tipCents +
		deliveryFeeCents +
		serviceFee.feeCents +
		packagingFee.feeCents

	const readySlotCapacity = computeReadySlotCapacity({
		slotLimitsEnabled: context.slotLimits?.enabled === true,
		location,
		fulfillment: request.fulfillment,
		scheduledFor,
		now,
		catalog,
		categoryExempt,
		lines: pricedLines.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			categoryIds: line.categoryIds,
		})),
	})

	return {
		ok: true,
		result: {
			currency,
			lines: pricedLines,
			subtotalCents,
			taxCents: orderTaxCents,
			taxInclusive,
			taxRatePercent,
			tipCents,
			tipPercent: tip.tipPercent,
			deliveryFeeCents,
			serviceFeeCents: serviceFee.feeCents,
			serviceFeeTaxCents: serviceFee.taxCents,
			serviceFeeLabel: serviceFeeRule ? serviceFeeRule.settings.label : null,
			serviceFeeRule,
			packagingFeeCents: packagingFee.feeCents,
			packagingFeeTaxCents: packagingFee.taxCents,
			packagingFeeLabel: packagingFeeRule
				? packagingFeeRule.settings.label
				: null,
			packagingFeeRule,
			totalCents,
			location: {
				id: location.id,
				name: location.name,
				timezone: location.timezone || 'UTC',
			},
			pickup: pickupInfo,
			drop: dropInfo,
			delivery: deliveryInfo,
			scheduledFor,
			holdMinutes,
			capacity,
			readySlotCapacity,
		},
	}
}

/**
 * Tax contained in a tax-inclusive amount: `amount * rate / (100 + rate)`,
 * rounded once for the whole order like exclusive tax.
 */
export function inclusiveTaxCents(
	taxInclusiveCents: number,
	taxRatePercent: number,
): number {
	const rate = Math.max(0, Math.min(100, taxRatePercent || 0))
	if (!(rate > 0) || !(taxInclusiveCents > 0)) return 0
	return Math.round((taxInclusiveCents * rate) / (100 + rate))
}

export type OrderDiscountTotals = {
	/** Sum of the line discounts, each capped at its line's total. */
	discountCents: number
	/** The delivery fee taken off, capped at the fee. */
	deliveryDiscountCents: number
	taxCents: number
	/** Customer total: tip stays on the pre-discount subtotal. */
	totalCents: number
	/** The service fee on the discounted subtotal, before its tax. */
	serviceFeeCents: number
	/** The part of `taxCents` that is on the fee. */
	serviceFeeTaxCents: number
	packagingFeeCents: number
	packagingFeeTaxCents: number
}

/**
 * Totals after discounts (coupons, automatic discounts, loyalty), applied line
 * by line before tax. `lineDiscounts` maps a line id (`String(index)` of
 * `priced.lines`) to its total discount; ids that match no line are ignored.
 * Each line's taxable amount drops by its own discount, floored at 0 (a
 * discount on an untaxed line never lowers the tax), tax is recomputed once on
 * the sum, inclusive or exclusive like the original pricing, and the tip keeps
 * the pre-discount subtotal:
 * `total = subtotal - discounts + tax (exclusive only) + tip + (delivery - delivery discount) + service fee`.
 * The service fee is re-priced on the discounted subtotal (discounts and
 * loyalty first, then the fee, before tax and tip); its tax joins `taxCents`.
 */
export function applyOrderDiscounts(
	priced: Pick<
		PricedRestaurantOrder,
		| 'lines'
		| 'subtotalCents'
		| 'taxInclusive'
		| 'taxRatePercent'
		| 'tipCents'
		| 'deliveryFeeCents'
		| 'serviceFeeRule'
		| 'packagingFeeCents'
		| 'packagingFeeRule'
	>,
	lineDiscounts: Readonly<Record<string, number>>,
	deliveryDiscountMinor = 0,
	/** An applied discount waives the packaging fee (#408). */
	packagingWaived = false,
): OrderDiscountTotals {
	// One shared calculation with the till and the ZATCA invoice. The discount
	// comes off the taxed and untaxed parts of a line in proportion, and a
	// discount on an untaxed line never lowers the tax.
	const base = discountedTaxableCents({
		lines: priced.lines.map((line, index) => ({
			totalCents: line.totalCents,
			taxableCents: line.taxableCents,
			offCents: lineDiscounts[String(index)],
		})),
	})
	const discountCents = base.lineOffCents
	const taxableAfter = base.taxableAfterCents
	// A non-finite amount (NaN from a bad parse) is no discount, never NaN totals.
	const deliveryDiscountCents = Math.min(
		Number.isFinite(deliveryDiscountMinor)
			? Math.max(0, Math.trunc(deliveryDiscountMinor))
			: 0,
		Math.max(0, priced.deliveryFeeCents),
	)
	const itemTaxCents = priced.taxInclusive
		? inclusiveTaxCents(taxableAfter, priced.taxRatePercent)
		: Math.round((taxableAfter * priced.taxRatePercent) / 100)
	// The fee comes after every discount and reward, before tax and tip.
	const serviceFee = computeServiceFee({
		settings: priced.serviceFeeRule?.settings ?? null,
		fulfillment: priced.serviceFeeRule?.fulfillment ?? 'pickup',
		baseCents: priced.subtotalCents - discountCents,
		taxRatePercent: priced.taxRatePercent,
		taxInclusive: priced.taxInclusive,
	})
	const packagingFee = computePackagingFee({
		settings: packagingWaived
			? null
			: (priced.packagingFeeRule?.settings ?? null),
		fulfillment: priced.packagingFeeRule?.fulfillment ?? 'pickup',
		itemUnits: priced.packagingFeeRule?.itemUnits ?? 0,
		taxRatePercent: priced.taxRatePercent,
		taxInclusive: priced.taxInclusive,
	})
	const taxCents = itemTaxCents + serviceFee.taxCents + packagingFee.taxCents
	const totalCents =
		priced.subtotalCents -
		discountCents +
		(priced.taxInclusive ? 0 : taxCents) +
		priced.tipCents +
		(priced.deliveryFeeCents - deliveryDiscountCents) +
		serviceFee.feeCents +
		packagingFee.feeCents
	return {
		discountCents,
		deliveryDiscountCents,
		taxCents,
		totalCents,
		serviceFeeCents: serviceFee.feeCents,
		serviceFeeTaxCents: serviceFee.taxCents,
		packagingFeeCents: packagingFee.feeCents,
		packagingFeeTaxCents: packagingFee.taxCents,
	}
}

function zoneMinimumOrderCents(
	subtotalCents: number,
	location: PublicLocationContext,
	zoneId: string,
): boolean {
	const zone = (location.deliveryZones ?? []).find(
		(candidate) => candidate.id === zoneId,
	)
	if (!zone || !(zone.minimumOrder > 0)) return false
	return subtotalCents < dollarsToCents(zone.minimumOrder)
}

function minimumOrderText(minimumOrder: number): string {
	return minimumOrder.toFixed(2)
}

// ---------------------------------------------------------------------------
// Public ordering options (GET /orders/options) — availability only, no PII
// ---------------------------------------------------------------------------

export type PublicOrderingSlot = {
	time: string
	ordersRemaining: number | null
	leadTimePassed: boolean
}

export type PublicOrderingWindow = {
	id: string
	locationId: string
	date: string
	startTime: string
	endTime: string
	slotIntervalMinutes: number
	orderLeadTimeMinutes: number
	maxOrdersPerSlot: number | null
	timezone: string
	slots: PublicOrderingSlot[]
}

export type PublicOrderingOptions = {
	slug: string | null
	locationId: string
	dropSlug: string | null
	onlinePayment: { enabled: boolean; processor: 'connect' | 'checkout' | null }
	ordering: {
		open: boolean
		status: LocationOrderingAvailability['status']
		reason: string | null
		nextOpen: string | null
		/** Set while an operator has paused online ordering. */
		paused: LocationOrderingAvailability['paused'] | null
		/** Prep estimate in minutes, busy mode included. */
		prepMinutes: number
		/** Extra minutes busy mode adds right now (0 when off). */
		busyExtraPrepMinutes: number
		/**
		 * ASAP delivery window in minutes from now: prep + busy minutes + the
		 * delivery time range (`deliveryArrivalWindowMinutes`), the same window
		 * an ASAP delivery order is promised (plus the large-order extra when
		 * the cart is over the threshold). Null when the location does not
		 * deliver.
		 */
		deliveryMinutes: { min: number; max: number } | null
		/**
		 * The location's large-order rule (not personal data): checkout adds
		 * `extraPrepMinutes` with `largeOrderExtraMinutes` when the cart is
		 * over the threshold, as the region does at placement. Null when
		 * there is none (or it is malformed).
		 */
		largeOrder: LargeOrderRule | null
	}
	fulfillment: { pickup: boolean; delivery: boolean }
	tips: { pickup: boolean; delivery: boolean }
	/**
	 * The tip buttons per order type (#118) and the location's currency, so
	 * Sites can show amounts and the custom cap. Absent on nodes that predate
	 * it: Sites then shows the old 10, 15, 18 and 20 percent buttons.
	 */
	tipChoices?: { currency: string; settings: TipSettings }
	/**
	 * The guest service fee (#123) of this location while it is on; null when
	 * off. Sites shows it with `computeServiceFee`; the region re-prices it.
	 */
	serviceFee?: ServiceFeeSettings | null
	/**
	 * The packaging or bag fee (#408) of this location while it is on; null when
	 * off. Sites shows it with `computePackagingFee`; the region re-prices it.
	 */
	packagingFee?: PackagingFeeSettings | null
	/**
	 * The most guests one table may order for from the phone (#422), or null
	 * when there is no such limit. Sites asks "How many are at your table?" only
	 * where this is set and sends `guestCount`; the region enforces it.
	 */
	dineInMaxGuests?: number | null
	/**
	 * Whether checkout asks about utensils and napkins at this location (#257),
	 * and the checkbox's default. Null when it does not ask. Pickup and
	 * delivery only: Sites never shows it for a table.
	 */
	utensils?: { enabled: boolean; defaultRequested: boolean } | null
	/**
	 * The location's pickup instructions (#251) as the operator saved them (plain
	 * text, or a localized JSON map): Sites picks the guest's language with
	 * `resolvePickupInstructions`. Null when empty.
	 */
	pickupInstructions?: string | null
	/**
	 * Daily limits (#409), ids and counts only: a dish or option that is sold out
	 * for today, and a low number where the operator allows "Only N left". A
	 * cap that is not shown never appears. Keys are `item:<id>` / `option:<id>`.
	 */
	dailyAvailability?: DailyDishAvailability
	delivery: { available: boolean }
	/**
	 * Whether the checkout may offer "Text me order updates": the guest
	 * messages flag is on and this is the US node. Policy only, no PII.
	 */
	guestMessages: { smsUpdates: boolean }
	drop: null | {
		slug: string
		title: string
		status: string
		ordersOpenAt: string | null
		ordersCloseAt: string | null
		holdMinutes: number
		windows: PublicOrderingWindow[]
		entityRemaining: {
			items: Record<string, number | null>
			categories: Record<string, number | null>
		}
	}
}

export type OrderingOptionsCounts = {
	/** Active orders per `${windowId}|${slotTime}` */
	slotOrders: Map<string, number>
	/** Reserved quantity per `item|${entityId}` / `category|${entityId}` */
	entityUsed: Map<string, number>
}

/**
 * Builds the public capability/availability response for the ordering UI.
 * Contains only aggregate availability counts — never customer data.
 */
export function buildPublicOrderingOptions(
	context: RestaurantOrderContext,
	input: {
		slug: string | null
		locationId: string
		dropSlug: string | null
		counts: OrderingOptionsCounts
		now: Date
		/** Whether this node can geocode addresses (radius/polygon zones). */
		geocoderAvailable?: boolean
		/** Today's sold-out and low-stock capped dishes (region read, #409). */
		dailyAvailability?: DailyDishAvailability
	},
):
	| { ok: true; options: PublicOrderingOptions }
	| { ok: false; error: RestaurantOrderError } {
	const location = context.menu.locations.find(
		(candidate) => candidate.id === input.locationId,
	)
	if (!location) {
		return {
			ok: false,
			error: orderError(
				404,
				'location_not_found',
				'This location is not available for ordering.',
			),
		}
	}
	const availability = isLocationOpenForOrdering(location, input.now)
	const options: PublicOrderingOptions = {
		slug: input.slug,
		locationId: location.id,
		dropSlug: input.dropSlug,
		onlinePayment: {
			enabled: context.onlinePayment.enabled,
			processor: context.onlinePayment.processor,
		},
		ordering: {
			open: availability.isOpen,
			status: availability.status,
			reason: availability.reason ?? null,
			nextOpen: availability.nextOpen ?? null,
			paused: availability.paused ?? null,
			prepMinutes: availability.estimatedPrepTime,
			busyExtraPrepMinutes: availability.busyExtraPrepMinutes ?? 0,
			deliveryMinutes:
				location.fulfillmentOptions.delivery &&
				availability.estimatedDeliveryTime
					? availability.estimatedDeliveryTime
					: null,
			largeOrder: readLargeOrderRule(context.largeOrder, location.id),
		},
		fulfillment: {
			pickup: Boolean(location.fulfillmentOptions.pickup),
			delivery: Boolean(location.fulfillmentOptions.delivery),
		},
		tips: {
			pickup: Boolean(location.inHouseTips.pickupTips),
			delivery: Boolean(location.inHouseTips.deliveryTips),
		},
		tipChoices: {
			currency: location.currency,
			settings: resolveTipSettings(location.tipSettings, location.currency),
		},
		serviceFee: (() => {
			const policy = readServiceFeePolicy(context.serviceFee, location.id)
			return policy.kind === 'on' ? policy.settings : null
		})(),
		packagingFee: (() => {
			const policy = readPackagingFeePolicy(context.packagingFee, location.id)
			return policy.kind === 'on' ? policy.settings : null
		})(),
		dineInMaxGuests:
			readOrderCapsForLocation(context.orderCaps, location.id)?.dineIn
				?.maxGuests ?? null,
		utensils: (() => {
			const settings = parseUtensilsSettings(context.utensils?.[location.id])
			return settings.enabled ? settings : null
		})(),
		// A drop has its own pickup location and windows, which win (#251).
		pickupInstructions: input.dropSlug
			? null
			: context.pickupInstructions?.[location.id]?.trim() || null,
		...(input.dailyAvailability &&
		Object.keys(input.dailyAvailability).length > 0
			? { dailyAvailability: input.dailyAvailability }
			: {}),
		delivery: {
			available:
				Boolean(location.fulfillmentOptions.delivery) &&
				deliveryCoverageVerifiable(location, {
					geocoderAvailable: input.geocoderAvailable ?? false,
				}),
		},
		guestMessages: {
			smsUpdates:
				readGuestMessagesPolicy(context.guestMessages).enabled &&
				context.dataRegion === 'us',
		},
		drop: null,
	}

	if (input.dropSlug) {
		const dropData = context.drop
		if (
			!dropData ||
			dropData.drop.slug.toLowerCase() !== input.dropSlug.toLowerCase()
		) {
			return {
				ok: false,
				error: orderError(404, 'drop_not_found', 'This drop is not available.'),
			}
		}
		const windows: PublicOrderingWindow[] = []
		for (const window of dropData.pickupWindows) {
			const slots = generatePickupSlots(
				window.startTime,
				window.endTime,
				window.slotIntervalMinutes,
			)
			const timezone = window.location?.timezone || location.timezone || 'UTC'
			const windowSlots: PublicOrderingSlot[] = slots.map((slot) => {
				const used =
					input.counts.slotOrders.get(`${window.id}|${slot.time}`) ?? 0
				const slotStart = localDateAndTimeToUtc(
					window.date,
					slot.time,
					timezone,
				)
				return {
					time: slot.time,
					ordersRemaining:
						window.maxOrdersPerSlot != null
							? Math.max(0, window.maxOrdersPerSlot - used)
							: null,
					leadTimePassed:
						slotStart.getTime() >=
						input.now.getTime() + window.orderLeadTimeMinutes * 60 * 1000,
				}
			})
			windows.push({
				id: window.id,
				locationId: window.locationId,
				date: window.date,
				startTime: window.startTime,
				endTime: window.endTime,
				slotIntervalMinutes: window.slotIntervalMinutes,
				orderLeadTimeMinutes: window.orderLeadTimeMinutes,
				maxOrdersPerSlot: window.maxOrdersPerSlot ?? null,
				timezone,
				slots: windowSlots,
			})
		}

		const items: Record<string, number | null> = {}
		const categories: Record<string, number | null> = {}
		for (const override of dropData.inventoryOverrides) {
			const used =
				input.counts.entityUsed.get(
					`${override.entityType}|${override.entityId}`,
				) ?? 0
			const remaining =
				override.inventory != null
					? Math.max(0, override.inventory - used)
					: null
			if (override.entityType === 'item') items[override.entityId] = remaining
			else categories[override.entityId] = remaining
		}

		options.drop = {
			slug: dropData.drop.slug,
			title: dropData.drop.title,
			status: getDropDisplayStatus(
				dropData.drop.status as
					'draft' | 'scheduled' | 'live' | 'closed' | 'completed',
				dropData.drop.ordersOpenAt ?? null,
				dropData.drop.ordersCloseAt ?? null,
				input.now,
			),
			ordersOpenAt: dropData.drop.ordersOpenAt ?? null,
			ordersCloseAt: dropData.drop.ordersCloseAt ?? null,
			holdMinutes: clampInt(
				dropData.drop.checkoutHoldMinutes,
				RESTAURANT_MIN_HOLD_MINUTES,
				RESTAURANT_MAX_HOLD_MINUTES,
				RESTAURANT_ONLINE_HOLD_MINUTES,
			),
			windows,
			entityRemaining: { items, categories },
		}
	}

	return { ok: true, options }
}

export {
	type OrderLimitExempt,
	type SlotUsageInput,
	type SlotUsageLine,
	orderDishUnits,
	slotLimitForFulfillment,
	slotUsageUnits,
	wouldExceedSlotLimit,
} from './slot-usage.ts'
export {
	kitchenStartInstantMs,
	prepMinutesAt,
	prepRowInForce,
} from './prep-schedule.ts'
export {
	computeReadySlotCapacity,
	readyInstantMs,
	type ReadySlotCapacitySpec,
} from './ready-slot-capacity.ts'
export { orderLimitExemptFromCatalog } from './order-limit-exempt.ts'
export {
	buildOrderLimitCatalog,
	readySlotUnitsForOrder,
	slotUsageLinesFromStored,
} from './order-limit-catalog.ts'
