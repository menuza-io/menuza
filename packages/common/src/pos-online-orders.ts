import { z } from 'zod'
import { ORDER_REJECT_REASONS } from './order-lifecycle.ts'

/**
 * Station's Orders app: the location's online orders (web and QR) from arrival
 * to handed over, on a paired terminal, with no App login. The browser calls
 * the regional tenant-api directly (`/pos/online-orders`; `/pos/orders` is the
 * till's own order upload). Responses are `no-store` and nothing is kept on the
 * tablet. The guest's phone is masked to its last four digits and the email is
 * left out, unless a person with the contact permission asks for them, one
 * order at a time; they are never printed unmasked.
 */

export const POS_ONLINE_ORDERS_FEED_LIMIT = 200
/** Phone orders rung up on Station tills that wait to be collected. */
export const POS_ONLINE_ORDERS_PHONE_LIMIT = 100
/** The inbox starts here: older open orders still show, finished ones drop off. */
export const POS_ONLINE_ORDERS_RECENT_MS = 24 * 60 * 60_000
/** Finished orders stay in the inbox (and open to every action) this long. */
export const POS_ONLINE_ORDERS_FINISHED_MS = 4 * 3_600_000

/**
 * Search reaches today and this many days before it at the location. The
 * tablet sends the start of that local day; the server never reaches further
 * back than this many days plus one, whatever it is sent.
 */
export const POS_ONLINE_ORDERS_SEARCH_DAYS = 7
export const POS_ONLINE_ORDERS_SEARCH_MAX_MS =
	(POS_ONLINE_ORDERS_SEARCH_DAYS + 1) * 24 * 3_600_000
/** At most this many results; the answer says when more matched. */
export const POS_ONLINE_ORDERS_SEARCH_LIMIT = 50
/**
 * A phone search takes exactly the last four digits: what the masked phone
 * already shows, so searching never reveals more of a number than that.
 */
export const POS_ONLINE_ORDERS_PHONE_DIGITS = 4
/** Text searches need at least this many characters. */
export const POS_ONLINE_ORDERS_SEARCH_TEXT_MIN = 2

/**
 * What a signed-in person may do in the Orders app. The till's own roles
 * decide (`pos_managers`, the host roster's guest details), so an owner sets
 * them where they already set who is a manager:
 * - everyone signed in views orders and manages them (ready, handed over,
 *   payment taken at handoff);
 * - the guest's full phone and email: managers, and hosts given guest details;
 * - cancel and refund: managers.
 */
export const POS_ONLINE_ORDERS_PERMISSIONS = [
	'view',
	'manage',
	'contact',
	'cancel',
	'refund',
] as const
export type PosOnlineOrdersPermission =
	(typeof POS_ONLINE_ORDERS_PERMISSIONS)[number]
export type PosOnlineOrdersGrants = Record<PosOnlineOrdersPermission, boolean>

export function posOnlineOrdersGrants(person: {
	role: 'cashier' | 'manager'
	guestDetails: boolean
}): PosOnlineOrdersGrants {
	const manager = person.role === 'manager'
	return {
		view: true,
		manage: true,
		contact: manager || person.guestDetails,
		cancel: manager,
		refund: manager,
	}
}

/** The same choices the till offers when it voids a sale, for an online order. */
export const POS_ONLINE_ORDER_CANCEL_REASONS = [
	'guest_request',
	'out_of_stock',
	'too_busy',
	'duplicate',
	'other',
] as const
export type PosOnlineOrderCancelReason =
	(typeof POS_ONLINE_ORDER_CANCEL_REASONS)[number]

export const posOnlineOrderStatusSchema = z.enum([
	'accepted',
	'preparing',
	'ready',
	'completed',
	'cancelled',
	/**
	 * Waiting for a person to accept or reject it (#107, the location's
	 * manual acceptance). Only organizations with `ordering.manual_acceptance`
	 * on ever have one; listed first in the inbox.
	 */
	'pending_acceptance',
])
export type PosOnlineOrderStatus = z.infer<typeof posOnlineOrderStatusSchema>

/** A sha256 of what the counter acts on; a command names the one it saw. */
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(100)

export const posOnlineOrderSummarySchema = z.strictObject({
	id,
	number: z.string().max(40),
	version: versionSchema,
	status: posOnlineOrderStatusSchema,
	fulfillment: z.enum(['pickup', 'delivery', 'dine_in']),
	/** Where it came from: a QR table or poster, else the website or app. */
	channel: z.enum(['web', 'qr']),
	tableLabel: z.string().max(60).nullable(),
	/** As the guest gave it. */
	guestName: z.string().max(200),
	createdAt: z.number().int(),
	/** The promised time (scheduled, or the pickup slot); null is as soon as possible. */
	dueAt: z.number().int().nullable(),
	paymentMethod: z.enum(['online', 'handoff']),
	paymentStatus: z.string().max(40),
	/** On a QR table tab: paid when the tab closes, never one round alone. */
	onTab: z.boolean(),
	currency: z.string().length(3),
	totalCents: z.number().int(),
	refundedCents: z.number().int(),
	itemCount: z.number().int().nonnegative(),
	/** When someone first opened it on a Station at this location (silences the alert everywhere). */
	openedAt: z.number().int().nullable(),
	completedAt: z.number().int().nullable(),
	cancelledAt: z.number().int().nullable(),
	/**
	 * Refunds at a glance (#80): `pending` while the payment provider has not
	 * answered, `failed` when the newest one failed (the amount is refundable
	 * again), else `none` / `partial` / `full` by what came back. Absent from
	 * an older region.
	 */
	refundStatus: z
		.enum(['none', 'pending', 'failed', 'partial', 'full'])
		.optional(),
	/** Provider refunds still waiting (not in `refundedCents` yet). */
	refundPendingCents: z.number().int().nonnegative().optional(),
	/** An open or lost payment dispute: refunds are refused. */
	disputed: z.boolean().optional(),
	/**
	 * Manual acceptance (#107): when the order is (or was) turned down
	 * automatically if nobody decides (epoch ms). Present only on orders that
	 * waited for acceptance.
	 */
	acceptanceDeadlineAt: z.number().int().nullable().optional(),
	/**
	 * Why it was turned down while it waited (`out_of_stock`,
	 * `kitchen_closed`, `too_busy`, `other`, or `not_accepted_in_time` when
	 * nobody decided). Present only on rejected orders.
	 */
	rejectedReason: z.string().max(40).nullable().optional(),
})
export type PosOnlineOrderSummary = z.infer<typeof posOnlineOrderSummarySchema>

export const posPhonePickupSchema = z.strictObject({
	id,
	number: z.string().max(40),
	guestName: z.string().max(200).nullable(),
	pickupAt: z.number().int().nullable(),
	status: z.enum(['open', 'paid']),
	currency: z.string().length(3),
	totalCents: z.number().int(),
})
export type PosPhonePickup = z.infer<typeof posPhonePickupSchema>

const grantsSchema = z.strictObject({
	view: z.boolean(),
	manage: z.boolean(),
	contact: z.boolean(),
	cancel: z.boolean(),
	refund: z.boolean(),
})

export const posOnlineOrdersFeedSchema = z.strictObject({
	orders: z.array(posOnlineOrderSummarySchema),
	phonePickups: z.array(posPhonePickupSchema),
	grants: grantsSchema,
	serverNow: z.number().int(),
	/** More orders than the feed carries: the oldest finished ones were left out. */
	truncated: z.boolean(),
})
export type PosOnlineOrdersFeed = z.infer<typeof posOnlineOrdersFeedSchema>

/** What a search may ask: one of text (order number or name) or trailing phone digits. */
export const POS_ONLINE_ORDERS_SEARCH_STATES = [
	'all',
	'open',
	'ready',
	'completed',
	'cancelled',
] as const
export type PosOnlineOrdersSearchState =
	(typeof POS_ONLINE_ORDERS_SEARCH_STATES)[number]

export const posOnlineOrdersSearchQuerySchema = z
	.strictObject({
		/** Order number or guest name. */
		q: z
			.string()
			.trim()
			.min(POS_ONLINE_ORDERS_SEARCH_TEXT_MIN)
			.max(60)
			.optional(),
		/** The phone's last four digits (contact permission only). */
		phone: z
			.string()
			.trim()
			.regex(new RegExp(`^[0-9]{${POS_ONLINE_ORDERS_PHONE_DIGITS}}$`))
			.optional(),
		state: z.enum(POS_ONLINE_ORDERS_SEARCH_STATES).default('all'),
		fulfillment: z
			.enum(['all', 'pickup', 'delivery', 'dine_in'])
			.default('all'),
		/** Start of the window (epoch ms): the tablet's local midnight seven days ago. */
		since: z.coerce.number().int().nonnegative().optional(),
	})
	.refine((query) => Boolean(query.q) !== Boolean(query.phone), {
		message: 'search by text or by phone digits',
	})
/** What the tablet sends (the server parses the query string with the schema above). */
export type PosOnlineOrdersSearchQuery = {
	q?: string
	phone?: string
	state?: PosOnlineOrdersSearchState
	fulfillment?: 'all' | 'pickup' | 'delivery' | 'dine_in'
	since?: number
}

export const posOnlineOrdersSearchSchema = z.strictObject({
	/** Newest first. Same summaries as the inbox: the name, never a phone. */
	results: z.array(posOnlineOrderSummarySchema),
	/** More orders matched than the answer carries. */
	truncated: z.boolean(),
	/** Where the search really started (the server may have moved it later). */
	since: z.number().int(),
	serverNow: z.number().int(),
})
export type PosOnlineOrdersSearch = z.infer<typeof posOnlineOrdersSearchSchema>

/** The search window's start: local midnight `POS_ONLINE_ORDERS_SEARCH_DAYS` days before today. */
export function onlineOrdersSearchSince(now: number): number {
	const start = new Date(now)
	start.setHours(0, 0, 0, 0)
	start.setDate(start.getDate() - POS_ONLINE_ORDERS_SEARCH_DAYS)
	return start.getTime()
}

/**
 * Whether the inbox still holds an order: open, or finished in the last four
 * hours. Only such orders take actions on Station; older ones found by search
 * are read-only there (their refunds and contacts are the App's).
 */
export function onlineOrderInInbox(
	order: Pick<PosOnlineOrderSummary, 'status' | 'completedAt' | 'cancelledAt'>,
	now: number,
): boolean {
	if (order.status !== 'completed' && order.status !== 'cancelled') return true
	const finished = order.completedAt ?? order.cancelledAt
	return finished !== null && finished >= now - POS_ONLINE_ORDERS_FINISHED_MS
}

/** Dish, variant and option names may be JSON maps of every menu language. */
const menuText = z.string().max(4000)
const lineSchema = z.strictObject({
	name: menuText,
	/** Variant names ("Large"); may be JSON language maps like the menu's. */
	variantNames: z.array(menuText),
	quantity: z.number().int(),
	totalCents: z.number().int(),
	instructions: z.string().max(400).nullable(),
	options: z.array(
		z.strictObject({
			name: menuText,
			quantity: z.number().int(),
			half: z.enum(['whole', 'left', 'right']).nullable(),
			/** Kitchen name and highlight. Omitted when unset, so an older till still reads the line. */
			kitchenName: menuText.optional(),
			groupName: menuText.optional(),
			highlight: z
				.enum(['none', 'allergy', 'attention', 'long_prep'])
				.optional(),
		}),
	),
	kitchenName: menuText.optional(),
	highlight: z.enum(['none', 'allergy', 'attention', 'long_prep']).optional(),
	courseId: z.string().max(40).optional(),
	courseName: menuText.optional(),
	coursePosition: z.number().int().optional(),
	held: z.boolean().optional(),
})
export type PosOnlineOrderLine = z.infer<typeof lineSchema>

export const posOnlineOrderDetailSchema = z.strictObject({
	order: posOnlineOrderSummarySchema.extend({
		lines: z.array(lineSchema),
		/** Masked to its last four digits ("•••• 0111"). */
		phoneMasked: z.string().max(40),
		hasEmail: z.boolean(),
		delivery: z
			.strictObject({
				address: z.string().max(400),
				city: z.string().max(200).nullable(),
				unit: z.string().max(100).nullable(),
				postalCode: z.string().max(40).nullable(),
				notes: z.string().max(600).nullable(),
			})
			.nullable(),
		subtotalCents: z.number().int(),
		taxCents: z.number().int(),
		deliveryFeeCents: z.number().int(),
		tipCents: z.number().int(),
		/**
		 * The guest service fee (#123) before its tax (the tax is in `taxCents`).
		 * Absent from an older node: none was charged.
		 */
		serviceFeeCents: z.number().int().optional(),
		/**
		 * The packaging or bag fee (#408) before its tax (the tax is in `taxCents`),
		 * and the name the guest saw. Absent from an older node: none was charged.
		 */
		packagingFeeCents: z.number().int().optional(),
		packagingFeeLabel: z.string().max(80).nullable().optional(),
		/** The guest's utensils answer (#257); null when it was not asked. */
		utensilsRequested: z.boolean().nullable().optional(),
		/**
		 * The pickup instructions the guest saw (#251): the restaurant's own text,
		 * not personal data. Plain text, escape it and keep the line breaks.
		 */
		pickupInstructions: z.string().max(400).nullable().optional(),
		/** Extra minutes a large order added to its promised time (#355). */
		largeOrderExtraMinutes: z.number().int().nonnegative().optional(),
		/** Over the location's large-order alert threshold at placement (#300). */
		largeOrder: z.boolean().optional(),
	/** The guest stated an allergy at checkout (#294). */
	guestAllergy: z.boolean().optional(),
	/** The order has alcohol: "Check ID" (#167). */
	checkId: z.boolean().optional(),
		discountCents: z.number().int(),
		loyaltyDiscountCents: z.number().int(),
		paidAt: z.number().int().nullable(),
		/**
		 * What a refund may still return: what was paid, less what came back and
		 * what a provider refund still waits on. Online payments are refunded
		 * through the payment provider; payment taken at handoff is recorded.
		 */
		refundableCents: z.number().int().nonnegative(),
		refunds: z.array(
			z.strictObject({
				amountCents: z.number().int(),
				note: z.string().max(400),
				at: z.number().int(),
				/** `record` (money given back at the counter) or `provider`. */
				kind: z.enum(['record', 'provider']).optional(),
				/** Only `succeeded` refunds count in `refundedCents`. */
				status: z.enum(['pending', 'succeeded', 'failed']).optional(),
				/** A failed provider refund's short machine code. */
				failureCode: z.string().max(64).nullable().optional(),
			}),
		),
		/** Who did what on Station: first names only. */
		history: z.array(
			z.strictObject({
				action: z.string().max(40),
				staffName: z.string().max(200).nullable(),
				reason: z.string().max(40).nullable(),
				amountCents: z.number().int().nullable(),
				at: z.number().int(),
			}),
		),
	}),
	grants: grantsSchema,
	serverNow: z.number().int(),
	/**
	 * Answer of a cancel that asked for `refund: 'full'`: whether the provider
	 * refund started, or the code saying why not (`payment_disputed`,
	 * `refund_pending`, `refund_complete`, `order_not_refundable`,
	 * `loyalty_refund_forbidden`). The order is cancelled either way.
	 */
	refundOutcome: z
		.strictObject({
			started: z.boolean(),
			code: z.string().max(40).nullable(),
		})
		.optional(),
})
export type PosOnlineOrderDetail = z.infer<
	typeof posOnlineOrderDetailSchema
>['order']
export type PosOnlineOrderDetailResponse = z.infer<
	typeof posOnlineOrderDetailSchema
>

export const posOnlineOrderContactSchema = z.strictObject({
	phone: z.string().max(40),
	email: z.string().max(320).nullable(),
})
export type PosOnlineOrderContact = z.infer<typeof posOnlineOrderContactSchema>

export const posOnlineOrderCommandSchema = z.discriminatedUnion('action', [
	z.strictObject({ action: z.literal('open') }),
	z.strictObject({
		action: z.literal('ready'),
		expectedVersion: versionSchema,
	}),
	z.strictObject({
		action: z.literal('handed_over'),
		expectedVersion: versionSchema,
		/** Payment was taken at handoff (pay-at-handoff orders only). */
		markPaid: z.boolean().default(false),
	}),
	z.strictObject({
		action: z.literal('cancel'),
		expectedVersion: versionSchema,
		reason: z.enum(POS_ONLINE_ORDER_CANCEL_REASONS),
		/**
		 * A paid online order: `full` also starts a refund of everything still
		 * refundable through the payment provider (refund permission needed);
		 * `none` or absent keeps the money. Not for orders paid at handoff.
		 */
		refund: z.enum(['none', 'full']).optional(),
	}),
	z.strictObject({
		action: z.literal('reprint'),
		ticket: z.enum(['guest', 'kitchen']),
	}),
	/**
	 * Manual acceptance (#107): an order waiting for acceptance goes to the
	 * kitchen (everyone signed in, like marking it ready).
	 */
	z.strictObject({
		action: z.literal('accept'),
		expectedVersion: versionSchema,
	}),
	/**
	 * Turns down an order waiting for acceptance (cancel permission). A paid
	 * online order is refunded in full through the payment provider; the
	 * answer's `refundOutcome` says whether the refund started.
	 */
	z.strictObject({
		action: z.literal('reject'),
		expectedVersion: versionSchema,
		reason: z.enum(ORDER_REJECT_REASONS),
	}),
])
export type PosOnlineOrderCommand = z.infer<typeof posOnlineOrderCommandSchema>

export const posOnlineOrderRefundSchema = z.union([
	z.strictObject({
		expectedVersion: versionSchema,
		amountCents: z.number().int().min(1).max(100_000_000),
		note: z.string().trim().min(3).max(280),
	}),
	z.strictObject({
		expectedVersion: versionSchema,
		full: z.literal(true),
		note: z.string().trim().min(3).max(280),
	}),
])
export type PosOnlineOrderRefund = z.infer<typeof posOnlineOrderRefundSchema>

/**
 * Whether handing over needs payment taken first: pay at handoff, not yet paid,
 * not free, and not a QR table round (a tab is paid when it closes).
 */
export function handoffNeedsPayment(order: {
	paymentMethod: 'online' | 'handoff'
	paymentStatus: string
	onTab: boolean
}): boolean {
	return (
		order.paymentMethod === 'handoff' &&
		!order.onTab &&
		order.paymentStatus !== 'paid' &&
		order.paymentStatus !== 'not_required'
	)
}

/** An order is late once its promised time (or, ASAP, 20 minutes after it came in) has passed. */
export const POS_ONLINE_ORDER_ASAP_MINUTES = 20
export function onlineOrderLate(
	order: Pick<
		PosOnlineOrderSummary,
		'status' | 'dueAt' | 'createdAt' | 'completedAt' | 'cancelledAt'
	>,
	now: number,
): boolean {
	if (order.status === 'completed' || order.status === 'cancelled') return false
	const due =
		order.dueAt ?? order.createdAt + POS_ONLINE_ORDER_ASAP_MINUTES * 60_000
	return now > due
}

/** New: nobody has opened it on a Station yet and nobody has started it. */
export function onlineOrderIsNew(
	order: Pick<PosOnlineOrderSummary, 'status' | 'openedAt'>,
): boolean {
	return order.status === 'accepted' && order.openedAt === null
}
