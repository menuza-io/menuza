import { z } from 'zod'
import {
	orderSendChannelSchema,
	orderStatusSchema,
	orderTextLocaleSchema,
	supplierOrderChannelSchema,
} from '../records.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	actorSchema,
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	listQuerySchema,
	minorOut,
	unitRefSchema,
} from './common.ts'
import { stockStatusSchema } from './items.ts'

/**
 * Phase 2: suggested orders, orders, sending and the text of an order.
 * Everything here is behind the `inventory.purchasing` flag (403
 * `feature_disabled` otherwise). Reads need `read:inventory:any`; creating,
 * editing, sending and cancelling need `update:inventory_purchasing:any` and
 * a `write` token. Money fields are omitted without
 * `read:inventory_cost:any`; the order TEXT never contains money, so it is
 * the same for everyone who can read.
 *
 * Quantities are base thousandths. `packs` is a decimal on the wire (at most
 * three decimals): whole for ordinary packs, in halves for a pack that is
 * "priced by weight" (`PRICED_BY_WEIGHT_PACK_STEP_MILLI`).
 */

/** A local calendar date and time at the location (the region owns time zones). */
export const localMomentSchema = z.object({
	date: isoDateSchema,
	time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
})

/** Longest `waLink` / `mailto` the region returns; longer ones are null and the App copies the text. */
export const ORDER_LINK_MAX_LENGTH = 2000

export const packsSchema = z
	.number()
	.positive()
	.max(100_000)
	.refine(
		(packs) => Math.abs(packs * 1000 - Math.round(packs * 1000)) < 1e-6,
		'At most three decimals',
	)

// ── Suggested orders ────────────────────────────────────────────────────────

/** `GET /orders/suggested?locationId=` (read). */
export const suggestedOrdersQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const suggestedOrderLineSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	onHand: z.number().int(),
	/** Still to arrive on sent or partly received orders. */
	onOrderQuantity: z.number().int(),
	orderBelowQuantity: z.number().int().nullable(),
	fillUpToQuantity: z.number().int().nullable(),
	status: stockStatusSchema,
	/** The supplier product chosen: preferred, else the only one, else the cheapest per base unit. */
	supplierProductId: z.string(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	pricedByWeight: z.boolean(),
	/** Suggested packs, rounded UP (`suggestOrderQuantity`). */
	packs: z.number(),
	/** What would arrive, base thousandths. */
	quantity: z.number().int(),
	packPriceMinor: minorOut,
	/** Estimated for a priced-by-weight pack. */
	lineTotalMinor: minorOut,
})
export type SuggestedOrderLine = z.infer<typeof suggestedOrderLineSchema>

/** One card of the "Suggested orders" row: a supplier and what to order from it. */
export const suggestedSupplierOrderSchema = z.object({
	supplierId: z.string(),
	supplierName: z.string(),
	orderChannel: supplierOrderChannelSchema,
	/** First delivery day this order can still make (`nextOrderableDelivery`), or null with no delivery days. */
	expectedDate: isoDateSchema.nullable(),
	/** When it must be sent by, local to the location. */
	cutoff: localMomentSchema.nullable(),
	/** The cut-off has passed for `expectedDate` right now (only when no later day fits the look-ahead). */
	cutoffPassed: z.boolean(),
	/** A draft already started for this supplier at this location: continue it instead of creating. */
	draftOrderId: z.string().nullable(),
	lineCount: z.number().int(),
	lines: z.array(suggestedOrderLineSchema),
	currency: currencyOut,
	totalMinor: minorOut,
	/** The supplier's minimum order (money). */
	minimumOrderMinor: minorOut,
	/** Cost grant only: the total is under the minimum. */
	belowMinimum: z.boolean().optional(),
	/** Lines whose pack has no price (left out of `totalMinor`). */
	unpricedLines: z.number().int().optional(),
})
export type SuggestedSupplierOrder = z.infer<
	typeof suggestedSupplierOrderSchema
>

/** An item that needs ordering but has no supplier product: "Add a supplier ›". */
export const unsourcedItemSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	onHand: z.number().int(),
	orderBelowQuantity: z.number().int().nullable(),
	fillUpToQuantity: z.number().int().nullable(),
})

export const suggestedOrdersSchema = z.object({
	locationId: z.string(),
	generatedAt: z.number().int(),
	/** Suppliers with something to order, most items first. */
	suppliers: z.array(suggestedSupplierOrderSchema),
	unsourced: z.array(unsourcedItemSchema),
	/** "9 items to order from 2 suppliers" (items on cards, not counting unsourced). */
	toOrderItems: z.number().int(),
})
export type SuggestedOrders = z.infer<typeof suggestedOrdersSchema>

// ── Orders ──────────────────────────────────────────────────────────────────

/** A line the person typed or kept. The region snapshots pack size and price from the supplier product. */
export const orderLineInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		supplierProductId: inventoryIdSchema,
		packs: packsSchema,
	})
	.strict()

/**
 * `POST /orders` (`update:inventory_purchasing:any`): a draft for one supplier
 * at one location. `fromSuggestion: true` fills the lines from the current
 * suggestion for that supplier (and `lines` must then be absent); otherwise
 * `lines` (possibly none) are used. Every supplier product must belong to
 * `supplierId` (409 `supplier_mismatch`). `expectedDate` defaults to the
 * supplier's next orderable delivery day. Replayed `clientId` answers the first
 * draft. Answers `orderDetailSchema`.
 */
export const createOrderSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema,
		expectedDate: isoDateSchema.nullable().optional(),
		note: inventoryNoteSchema.optional(),
		fromSuggestion: z.boolean().optional(),
		lines: z.array(orderLineInputSchema).max(200).optional(),
	})
	.strict()
	.refine((body) => !(body.fromSuggestion && body.lines !== undefined), {
		path: ['lines'],
		message: 'Send either fromSuggestion or lines',
	})
export type CreateOrder = z.infer<typeof createOrderSchema>

/**
 * `PATCH /orders/:id` (`update:inventory_purchasing:any`, `expectedVersion`).
 * `lines` replaces the draft's lines wholesale (steppers send the full list)
 * and is allowed only while the order is a `draft`; `expectedDate` and `note`
 * may also change on a `sent` or `partly_received` order. Anything else on a
 * closed order, or `lines` on a sent one, answers 409 `order_not_editable`.
 * Answers `orderDetailSchema`.
 */
export const updateOrderSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		expectedDate: isoDateSchema.nullable().optional(),
		note: inventoryNoteSchema.nullable().optional(),
		lines: z.array(orderLineInputSchema).max(200).optional(),
	})
	.strict()
	.refine(
		(body) =>
			body.expectedDate !== undefined ||
			body.note !== undefined ||
			body.lines !== undefined,
		{ message: 'Nothing to change' },
	)

/**
 * `POST /orders/:id/send` (`update:inventory_purchasing:any`).
 *
 * Allowed from `draft` (first send) and `sent` / `partly_received` (send
 * again); an order with no lines answers 409 `order_empty`, a closed one 409
 * `order_closed`. One call does everything: it renders the text, delivers it
 * when the channel is `email` and the region can, and moves a `draft` to
 * `sent` (recording `sentAt` once and `sentVia`). `whatsapp`, `copy` and
 * `pdf` are person-driven: the region marks the order sent and returns what
 * the App needs (a `wa.me` link, the text to copy, or the same text for the
 * App to print as a PDF; there is no server-side PDF in phase 2).
 */
export const sendOrderSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		channel: orderSendChannelSchema,
		/** Language of the text (default `en`); the App sends its current language. */
		locale: orderTextLocaleSchema.optional(),
	})
	.strict()

/** Why the region did not send an email itself. */
export const ORDER_EMAIL_SKIPPED_REASONS = [
	'not_configured',
	'no_supplier_email',
	'disabled',
] as const
export const orderEmailSkippedSchema = z.enum(ORDER_EMAIL_SKIPPED_REASONS)

export const orderTextSchema = z.object({
	locale: orderTextLocaleSchema,
	/** Email subject and the first line of a WhatsApp message. */
	subject: z.string(),
	/** Plain text: quantities in packs and in the item's unit, delivery date, note. Never money. */
	text: z.string(),
	/** `https://wa.me/<digits>?text=…` (without digits when the supplier has no phone), or null when too long. */
	waLink: z.string().nullable(),
	/** `mailto:<supplier email>?subject=…&body=…`, or null when too long. */
	mailto: z.string().nullable(),
})
export type OrderText = z.infer<typeof orderTextSchema>

/** `POST /orders/:id/cancel` (`update:inventory_purchasing:any`): from draft, sent or partly received. Stock already received stays. */
export const cancelOrderSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()

/** `GET /orders/:id/text?locale=` (read): the text exactly as send would produce it. */
export const orderTextQuerySchema = z
	.object({ locale: orderTextLocaleSchema.optional() })
	.strict()

export const orderLineSchema = z.object({
	id: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	supplierProductId: z.string().nullable(),
	/** Snapshots taken when the line was added; later price changes do not move them. */
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	pricedByWeight: z.boolean(),
	packs: z.number(),
	/** Ordered, base thousandths. */
	quantity: z.number().int(),
	/** Received so far over every delivery against the order. */
	receivedQuantity: z.number().int(),
	/** The packs the suggestion proposed, when the line came from one (to show "you changed it"). */
	suggestedPacks: z.number().nullable(),
	/** Hints for the review page, read when the order is read. */
	onHand: z.number().int().optional(),
	fillUpToQuantity: z.number().int().nullable().optional(),
	packPriceMinor: minorOut,
	lineTotalMinor: minorOut,
})
export type OrderLine = z.infer<typeof orderLineSchema>

export const orderSummarySchema = z.object({
	id: z.string(),
	/** Human number, 1, 2, 3 … per organization ("Order 12"). */
	number: z.number().int(),
	locationId: z.string(),
	supplierId: z.string(),
	supplierName: z.string(),
	status: orderStatusSchema,
	expectedDate: isoDateSchema.nullable(),
	cutoff: localMomentSchema.nullable(),
	note: z.string().nullable(),
	createdBy: actorSchema,
	createdAt: z.number().int(),
	sentAt: z.number().int().nullable(),
	sentVia: orderSendChannelSchema.nullable(),
	/** When it became `received` or `cancelled`. */
	closedAt: z.number().int().nullable(),
	lineCount: z.number().int(),
	/** Lines complete by `orderLineComplete`. */
	receivedLineCount: z.number().int(),
	version: z.number().int(),
	currency: currencyOut,
	/** Sum of the priced lines (an estimate when a line is priced by weight). */
	totalMinor: minorOut,
	minimumOrderMinor: minorOut,
	/** Cost grant only: how far under the supplier minimum (0 when met). */
	shortOfMinimumMinor: minorOut,
	unpricedLines: z.number().int().optional(),
})
export type OrderSummary = z.infer<typeof orderSummarySchema>

export const orderDetailSchema = orderSummarySchema.extend({
	lines: z.array(orderLineSchema),
	/** Deliveries recorded against it, oldest first. */
	deliveries: z.array(
		z.object({
			id: z.string(),
			receivedAt: z.number().int().nullable(),
			invoiceNumber: z.string().nullable(),
		}),
	),
	/** Business contact the operator typed, for the send dialog's default channel. */
	supplierOrderChannel: supplierOrderChannelSchema,
	supplierEmail: z.string().nullable(),
	supplierPhone: z.string().nullable(),
})
export type OrderDetail = z.infer<typeof orderDetailSchema>

/**
 * `GET /orders?locationId=&status=&supplierId=&limit=&cursor=` (read; newest
 * first). `open` is draft, sent and partly received; `closed` is received and
 * cancelled.
 */
export const listOrdersQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		status: z
			.union([z.enum(['open', 'closed', 'all']), orderStatusSchema])
			.default('open'),
		supplierId: inventoryIdSchema.optional(),
	})
	.strict()

export const listOrdersResultSchema = z.object({
	orders: z.array(orderSummarySchema),
	nextCursor: z.string().nullable(),
})

/**
 * `POST /orders/:id/send` answer.
 *
 * - `emailSent` is true only when the region itself delivered an email (the
 *   channel was `email`, the supplier has an address, and email is
 *   configured on the node: the region's own email on KSA, the US App's
 *   sending identity on US). A provider failure is 502 `email_failed` and the
 *   order stays as it was.
 * - Otherwise `emailSkipped` says why, and for the `email` channel `mailto`
 *   is the fallback (the order is still marked sent: the person opens their
 *   email app).
 * - `waLink` is set only for the `whatsapp` channel, `mailto` only for the
 *   `email` channel when `emailSent` is false.
 */
export const sendOrderResultSchema = orderTextSchema.extend({
	order: orderDetailSchema,
	channel: orderSendChannelSchema,
	emailSent: z.boolean(),
	emailSkipped: orderEmailSkippedSchema.nullable(),
})
export type SendOrderResult = z.infer<typeof sendOrderResultSchema>
