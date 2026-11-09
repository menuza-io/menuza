import { z } from 'zod'
import { inventoryMinorSchema } from '../money.ts'
import { orderStatusSchema, orderTextLocaleSchema } from '../records.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	minorOut,
	unitRefSchema,
} from './common.ts'
import { recordDeliveryResultSchema } from './results.ts'
import { orderTextSchema } from './orders.ts'

/**
 * Phase 2, the receiving side: prefilling a delivery from its order, asking
 * for credit, confirming prices of a quantity-only delivery, the invoice
 * photo and price alerts.
 */

const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')
		.nullable()
		.optional()

// ── Receive against an order ────────────────────────────────────────────────

export const receivePrefillLineSchema = z.object({
	orderLineId: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	supplierProductId: z.string().nullable(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	pricedByWeight: z.boolean(),
	orderedPacks: z.number(),
	/** Ordered, base thousandths. */
	orderedQuantity: z.number().int(),
	/** Received so far on earlier deliveries. */
	receivedQuantity: z.number().int(),
	/** Ordered minus received (0 when complete): what the stepper starts at. */
	outstandingQuantity: z.number().int(),
	outstandingPacks: z.number(),
	/** The supplier product's CURRENT pack price, to prefill; changing it shows the change in %. */
	packPriceMinor: minorOut,
	/** Outstanding packs × pack price (an estimate for a priced-by-weight pack). */
	lineTotalMinor: minorOut,
})

/**
 * `GET /orders/:id/receive-prefill` (read; flag `purchasing`): the lines of
 * `POST /deliveries` prefilled from an open order. A read, so the App can
 * call it freely; nothing is reserved. A cancelled or received order answers
 * 409 `order_closed`. The client builds the delivery from these lines (send
 * `orderId`, and per line `orderLineId` and `orderedQuantity`).
 */
export const receivePrefillSchema = z.object({
	orderId: z.string(),
	number: z.number().int(),
	locationId: z.string(),
	supplierId: z.string(),
	supplierName: z.string(),
	status: orderStatusSchema,
	expectedDate: isoDateSchema.nullable(),
	currency: currencyOut,
	lines: z.array(receivePrefillLineSchema),
})
export type ReceivePrefill = z.infer<typeof receivePrefillSchema>

// ── Credit ──────────────────────────────────────────────────────────────────

/**
 * `POST /deliveries/:id/credit-message` (read grant, `read` or `write` token;
 * a POST only because it has a body: it changes nothing and can be repeated).
 * Drafts the message asking the supplier for credit on lines of the
 * delivery's order that are short or missing (`creditLines`, the figures
 * after this delivery). `orderLineIds` limits it to some lines. A delivery
 * with no order, or nothing short, answers `text: null` and no lines.
 */
export const creditMessageRequestSchema = z
	.object({
		locale: orderTextLocaleSchema.optional(),
		orderLineIds: z.array(inventoryIdSchema).max(200).optional(),
		note: inventoryNoteSchema.optional(),
	})
	.strict()

export const creditMessageLineSchema = z.object({
	orderLineId: z.string().nullable(),
	itemId: z.string(),
	itemName: z.string(),
	packName: z.string().nullable(),
	orderedQuantity: z.number().int(),
	receivedQuantity: z.number().int(),
	shortQuantity: z.number().int(),
	kind: z.enum(['short', 'missing']),
	valueMinor: minorOut,
})

export const creditMessageSchema = orderTextSchema.extend({
	/** Null when there is nothing to ask credit for. */
	text: z.string().nullable(),
	subject: z.string().nullable(),
	deliveryId: z.string(),
	orderId: z.string().nullable(),
	supplierName: z.string().nullable(),
	lines: z.array(creditMessageLineSchema),
	/** Cost grant only: what the short lines are worth at the order's prices. */
	totalMinor: minorOut,
	currency: currencyOut,
})
export type CreditMessage = z.infer<typeof creditMessageSchema>

// ── Confirm prices of a quantity-only delivery ──────────────────────────────

/**
 * `POST /deliveries/:id/confirm-prices` (`update:inventory_purchasing:any`):
 * a person checks a delivery that arrived without prices (Station, or a
 * quantity-only `POST /deliveries`) against the invoice. Every unpriced line
 * must be listed once (`lines` covering exactly the delivery's lines with
 * `priced: false`); a delivery with none left answers 409 `prices_confirmed`.
 * The region then does what `POST /deliveries` does for priced lines (cost
 * per base unit from `lineTotalMinor / quantity`, last and weighted average
 * cost, supplier pack price from `packPriceMinor`, price changes), using
 * on hand minus this delivery's quantity (floored at zero) for the average,
 * sets `pricesPending` false and records the invoice facts. Answers
 * `recordDeliveryResultSchema`.
 */
export const confirmDeliveryPricesSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		currency: currencySchema,
		invoiceNumber: optionalText(60),
		invoiceDate: isoDateSchema.nullable().optional(),
		vatMinor: inventoryMinorSchema.nullable().optional(),
		totalMinor: inventoryMinorSchema.nullable().optional(),
		zatcaReference: optionalText(200),
		paid: z.boolean().default(false),
		lines: z
			.array(
				z
					.object({
						lineId: inventoryIdSchema,
						lineTotalMinor: inventoryMinorSchema,
						packPriceMinor: inventoryMinorSchema.nullable().optional(),
					})
					.strict(),
			)
			.min(1)
			.max(200),
	})
	.strict()
export type ConfirmDeliveryPrices = z.infer<typeof confirmDeliveryPricesSchema>

export const confirmDeliveryPricesResultSchema = recordDeliveryResultSchema

// ── Invoice photo ───────────────────────────────────────────────────────────

export const INVOICE_PHOTO_CONTENT_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
] as const
export const invoicePhotoContentTypeSchema = z.enum(INVOICE_PHOTO_CONTENT_TYPES)
/** The client downscales (about 1600 px long edge) before uploading. */
export const INVOICE_PHOTO_MAX_BYTES = 5 * 1024 * 1024

/**
 * `POST /deliveries/:id/invoice-photo` (`update:inventory:any`; Station:
 * `POST /pos/inventory/deliveries/:id/photo`): asks for a one-time upload
 * target in the REGION'S own object storage (generalised
 * `lib/recording-storage.ts`; key
 * `inventory-invoices/<orgId>/<deliveryId>/<random>.<ext>`, chosen by the
 * region). The browser then `PUT`s the bytes straight to `uploadUrl` with
 * the returned headers (no byte passes through App or Sites), and calls
 * `POST .../invoice-photo/confirm` with the `key`. One photo per delivery: a
 * new confirmed photo replaces (and deletes) the old one. Storage not
 * configured on the node: 503 `upload_not_configured` (a permanent refusal
 * for the Station queue: the delivery stays, the photo is dropped).
 */
export const invoicePhotoRequestSchema = z
	.object({
		contentType: invoicePhotoContentTypeSchema,
		sizeBytes: z.number().int().min(1).max(INVOICE_PHOTO_MAX_BYTES),
	})
	.strict()

export const invoicePhotoUploadSchema = z.object({
	key: z.string(),
	method: z.literal('PUT'),
	uploadUrl: z.string(),
	/** Headers the PUT must carry (content type and length are signed). */
	headers: z.record(z.string(), z.string()),
	expiresAt: z.number().int(),
	maxBytes: z.number().int(),
})
export type InvoicePhotoUpload = z.infer<typeof invoicePhotoUploadSchema>

/**
 * `POST /deliveries/:id/invoice-photo/confirm`: the region checks the object
 * exists and is within `maxBytes` and the declared type, then stores
 * `photo_key`. Answers the delivery (`deliveryDetailSchema`) on the operator
 * route and `{ ok: true }` on Station.
 */
export const confirmInvoicePhotoSchema = z
	.object({ key: z.string().min(1).max(300) })
	.strict()

// ── Price alerts ────────────────────────────────────────────────────────────

/**
 * `GET /price-alerts?locationId=&days=` (`read:inventory_cost:any`: the whole
 * answer is money, so a token without it gets 403 `forbidden`, not an empty
 * list). Items whose latest priced delivery at the location rose by MORE
 * than 5% (`priceRiseAlert`) against the delivery before it, within the last
 * `days` (default 30, at most 180), largest rise first.
 */
export const priceAlertsQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		days: z.coerce.number().int().min(1).max(180).default(30),
	})
	.strict()

export const priceAlertSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	supplierId: z.string().nullable(),
	supplierName: z.string().nullable(),
	/** The delivery that carried the new price. */
	deliveryId: z.string(),
	deliveredAt: z.number().int(),
	/** Cost per base unit (micro-minor) on the previous and the latest delivery. */
	previousCostMicro: z.number().int(),
	costMicro: z.number().int(),
	changeBp: z.number().int(),
	severity: z.enum(['rise', 'big']),
	packName: z.string().nullable(),
	previousPackPriceMinor: z.number().int().nullable(),
	packPriceMinor: z.number().int().nullable(),
	/** Dishes whose cost this moves (phase 3, needs recipes); null before. */
	affectedDishes: z.number().int().nullable(),
})
export type PriceAlert = z.infer<typeof priceAlertSchema>

export const priceAlertsSchema = z.object({
	locationId: z.string(),
	days: z.number().int(),
	thresholdBp: z.number().int(),
	currency: z.string(),
	alerts: z.array(priceAlertSchema),
})
export type PriceAlerts = z.infer<typeof priceAlertsSchema>

// ── Reading an invoice photo (phase 5) ──────────────────────────────────────

/**
 * `POST /deliveries/:id/invoice-photo/read` (`update:inventory_purchasing:any`,
 * empty body): a regional vision model reads the stored invoice photo into
 * suggested lines. It is only a help for the "check these lines" step: nothing
 * is recorded or priced from it. The photo and the model stay in the node's
 * own region (a node without an in-region reader answers 503
 * `reader_not_configured`; a delivery without a photo, 409 `no_photo`).
 * `text` is what the invoice said, as read (untrusted: show it, never act on
 * it); `itemId` is set only when the text matches an item of the delivery's
 * supplier or the catalogue by name. Money is left out without the cost grant.
 */
export const readInvoiceSchema = z.object({}).strict()

export const invoiceReadLineSchema = z.object({
	text: z.string(),
	quantity: z.number().nullable(),
	unit: z.string().nullable(),
	lineTotalMinor: minorOut,
	itemId: z.string().nullable(),
	itemName: z.string().nullable(),
})
export type InvoiceReadLine = z.infer<typeof invoiceReadLineSchema>

export const invoiceReadSchema = z.object({
	deliveryId: z.string(),
	supplierName: z.string().nullable(),
	invoiceNumber: z.string().nullable(),
	totalMinor: minorOut,
	lines: z.array(invoiceReadLineSchema),
})
export type InvoiceRead = z.infer<typeof invoiceReadSchema>
