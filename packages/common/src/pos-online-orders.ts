import { z } from 'zod'

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
		}),
	),
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
		discountCents: z.number().int(),
		loyaltyDiscountCents: z.number().int(),
		paidAt: z.number().int().nullable(),
		/** What a refund may still return (online payments only). */
		refundableCents: z.number().int().nonnegative(),
		refunds: z.array(
			z.strictObject({
				amountCents: z.number().int(),
				note: z.string().max(400),
				at: z.number().int(),
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
	}),
	z.strictObject({
		action: z.literal('reprint'),
		ticket: z.enum(['guest', 'kitchen']),
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
