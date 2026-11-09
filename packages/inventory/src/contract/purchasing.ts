import { z } from 'zod'
import { SUPPLIER_ORDER_CHANNELS } from '../records.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	actorSchema,
	clientIdSchema,
	currencyOut,
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNameSchema,
	inventoryNoteSchema,
	isoDateSchema,
	listQuerySchema,
	minorOut,
	positiveQuantitySchema,
} from './common.ts'

const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')
		.nullable()
		.optional()

// ── Suppliers ───────────────────────────────────────────────────────────────

/**
 * The supplier fields without defaults. `PATCH` is built from this one: Zod 4
 * applies a field's `.default()` even under `.partial()`, which would reset a
 * supplier's order channel and delivery days on every unrelated edit.
 */
const supplierFieldsSchema = z
	.object({
		name: inventoryNameSchema,
		contactName: optionalText(80),
		phone: optionalText(40),
		email: z.email().max(200).nullable().optional(),
		orderChannel: z.enum(SUPPLIER_ORDER_CHANNELS),
		/** Days they deliver, 0 = Sunday … 6 = Saturday. */
		deliveryDays: z.array(z.number().int().min(0).max(6)).max(7),
		/** Order by this local time … */
		cutoffTime: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.nullable()
			.optional(),
		/** … this many days before delivery. */
		cutoffDaysBefore: z.number().int().min(0).max(14).nullable().optional(),
		minimumOrderMinor: z.number().int().min(0).nullable().optional(),
		currency: currencySchema,
		paymentTerms: optionalText(80),
		vatNumber: optionalText(40),
		notes: inventoryNoteSchema.nullable().optional(),
	})
	.strict()

/** `POST /suppliers` and `PATCH /suppliers/:id` (`update:inventory_purchasing:any`). */
export const supplierInputSchema = supplierFieldsSchema
	.extend({
		orderChannel: supplierFieldsSchema.shape.orderChannel.default('phone'),
		deliveryDays: supplierFieldsSchema.shape.deliveryDays.default([]),
	})
	.strict()

export const createSupplierSchema = supplierInputSchema
	.extend({ clientId: clientIdSchema })
	.strict()

export const updateSupplierSchema = supplierFieldsSchema
	.partial()
	.extend({ expectedVersion: expectedVersionSchema })
	.strict()

export const supplierSchema = z.object({
	id: z.string(),
	name: z.string(),
	contactName: z.string().nullable(),
	phone: z.string().nullable(),
	email: z.string().nullable(),
	orderChannel: z.enum(SUPPLIER_ORDER_CHANNELS),
	deliveryDays: z.array(z.number().int()),
	cutoffTime: z.string().nullable(),
	cutoffDaysBefore: z.number().int().nullable(),
	currency: z.string(),
	paymentTerms: z.string().nullable(),
	vatNumber: z.string().nullable(),
	notes: z.string().nullable(),
	archived: z.boolean(),
	version: z.number().int(),
	productCount: z.number().int(),
	unpaidCount: z.number().int(),
	minimumOrderMinor: z.number().int().nullable().optional(),
	unpaidMinor: minorOut,
})
export type Supplier = z.infer<typeof supplierSchema>

/** `GET /suppliers?includeArchived=` */
export const listSuppliersQuerySchema = z
	.object({ includeArchived: z.stringbool().default(false) })
	.strict()

/** The answer: `{ suppliers, unpaidMinor?, currency? }` (sorted by name). */
export const listSuppliersResultSchema = z.object({
	suppliers: z.array(supplierSchema),
	unpaidMinor: minorOut,
	currency: currencyOut,
})

export const supplierProductSchema = z.object({
	id: z.string(),
	supplierId: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	pricedByWeight: z.boolean(),
	sku: z.string().nullable(),
	preferred: z.boolean(),
	version: z.number().int(),
	priceMinor: minorOut,
	currency: currencyOut,
})
export type SupplierProduct = z.infer<typeof supplierProductSchema>

/** `GET /suppliers/:id` */
export const supplierDetailSchema = supplierSchema.extend({
	products: z.array(supplierProductSchema),
})

/** Product fields without defaults (see `supplierFieldsSchema`). */
const supplierProductFieldsSchema = z
	.object({
		itemId: inventoryIdSchema,
		packName: inventoryNameSchema,
		packBaseQuantity: positiveQuantitySchema,
		priceMinor: z.number().int().min(0),
		pricedByWeight: z.boolean(),
		sku: optionalText(60),
		preferred: z.boolean(),
	})
	.strict()

/** `POST /suppliers/:id/products` (`update:inventory_purchasing:any`). */
export const supplierProductInputSchema = supplierProductFieldsSchema
	.extend({
		pricedByWeight:
			supplierProductFieldsSchema.shape.pricedByWeight.default(false),
		preferred: supplierProductFieldsSchema.shape.preferred.default(false),
	})
	.strict()

/** `PATCH /supplier-products/:id`; archive with `versionOnlySchema`. */
export const updateSupplierProductSchema = supplierProductFieldsSchema
	.omit({ itemId: true })
	.partial()
	.extend({ expectedVersion: expectedVersionSchema })
	.strict()

// ── Deliveries ──────────────────────────────────────────────────────────────

/**
 * One delivered line. The client works out `quantity` (packs × pack size, or
 * the real weight for "priced by weight") and `lineTotalMinor` (what the
 * invoice line says, before VAT); the region derives cost per base unit as
 * `lineTotalMinor / quantity`. `packPriceMinor`, when sent with a supplier
 * product, becomes that product's new price.
 *
 * Phase 2 (additive): `lineTotalMinor` is required unless the request is
 * `quantityOnly` (then it and `packPriceMinor` must be absent, see
 * `recordDeliverySchema`). `orderLineId` ties the line to a line of the
 * `orderId` the delivery is received against; `orderedQuantity` echoes what
 * the screen showed as ordered (informational: the region uses its own
 * figure and only keeps the echo in the audit detail).
 */
export const deliveryLineInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		supplierProductId: inventoryIdSchema.nullable().optional(),
		quantity: positiveQuantitySchema,
		packs: z.number().positive().max(100_000).nullable().optional(),
		packName: inventoryNameSchema.nullable().optional(),
		packBaseQuantity: positiveQuantitySchema.nullable().optional(),
		packPriceMinor: z.number().int().min(0).nullable().optional(),
		lineTotalMinor: z.number().int().min(0).optional(),
		/** Real weight (base thousandths) when the line is priced by weight. */
		realWeightQuantity: positiveQuantitySchema.nullable().optional(),
		/** Line of `orderId` this line receives (phase 2). */
		orderLineId: inventoryIdSchema.nullable().optional(),
		/** What the screen showed as ordered, base thousandths (phase 2, informational). */
		orderedQuantity: z.number().int().min(0).nullable().optional(),
	})
	.strict()

/** The request without the cross-field rules (kept so `.extend` stays possible). */
export const recordDeliveryBaseSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema.nullable(),
		invoiceNumber: optionalText(60),
		invoiceDate: isoDateSchema.nullable().optional(),
		/**
		 * Required unless `quantityOnly` (a token without the cost grant does not
		 * know the money format; the region then uses the organization's currency).
		 */
		currency: currencySchema.optional(),
		vatMinor: z.number().int().min(0).nullable().optional(),
		/** The invoice's grand total, to compare with the lines. */
		totalMinor: z.number().int().min(0).nullable().optional(),
		zatcaReference: optionalText(200),
		/** Needs `update:inventory_purchasing:any` (403 `purchasing_required` otherwise). */
		paid: z.boolean().default(false),
		/**
		 * Phase 2: received quantities only, no prices. See `recordDeliverySchema`.
		 */
		/** Absent means false. */
		quantityOnly: z.boolean().optional(),
		/** Phase 2: receive against this order (`update:inventory:any`, flag `purchasing`). */
		orderId: inventoryIdSchema.nullable().optional(),
		/**
		 * Phase 2: nothing more is coming for `orderId`: close it as `received`
		 * even if lines are short (the shortfalls stay readable for credit).
		 */
		/** Absent means false. */
		closeOrder: z.boolean().optional(),
		lines: z.array(deliveryLineInputSchema).min(1).max(200),
	})
	.strict()

/**
 * `POST /deliveries` (`update:inventory:any`). Posts a `delivery` movement per
 * line, updates last and average cost, and remembers pack prices.
 *
 * Who may send what:
 * - Priced lines (the default): any token with `update:inventory:any`, as in
 *   phase 1. Every line needs `lineTotalMinor` and `currency` is required.
 * - `paid: true` needs `update:inventory_purchasing:any` as well; without it
 *   the region answers 403 `purchasing_required` (save as unpaid instead).
 * - `quantityOnly: true` (phase 2): the cost-less path for staff and for
 *   tokens without `read:inventory_cost:any`. Any token with
 *   `update:inventory:any` may use it. No line may carry `lineTotalMinor` or
 *   `packPriceMinor`, and `vatMinor`, `totalMinor` and `paid: true` are
 *   refused. The region posts the stock in and does NOT touch costs or
 *   supplier prices for those lines; the delivery is stored with
 *   `pricesPending: true` and Today asks a person with the purchasing grant
 *   to confirm (`POST /deliveries/:id/confirm-prices`).
 * - `orderId` (phase 2): the lines are matched to the order's lines by
 *   `orderLineId`; the supplier must match the order (409 `supplier_mismatch`),
 *   and a cancelled or fully received order answers 409 `order_closed`. After
 *   posting, the region sets the order to `partly_received` or `received`
 *   (`orderStatusAfterReceipt`), or to `received` when `closeOrder` is true.
 * - A replayed `clientId` answers the first result.
 */
export const recordDeliverySchema = recordDeliveryBaseSchema.superRefine(
	(body, ctx) => {
		if (body.quantityOnly) {
			if (body.paid) {
				ctx.addIssue({
					code: 'custom',
					path: ['paid'],
					message: 'A quantity-only delivery cannot be marked paid',
				})
			}
			for (const key of ['vatMinor', 'totalMinor'] as const) {
				if (body[key] !== null && body[key] !== undefined) {
					ctx.addIssue({
						code: 'custom',
						path: [key],
						message: 'A quantity-only delivery carries no money',
					})
				}
			}
			body.lines.forEach((line, index) => {
				for (const key of ['lineTotalMinor', 'packPriceMinor'] as const) {
					if (line[key] !== null && line[key] !== undefined) {
						ctx.addIssue({
							code: 'custom',
							path: ['lines', index, key],
							message: 'A quantity-only line carries no money',
						})
					}
				}
			})
			return
		}
		if (body.currency === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['currency'],
				message: 'Required',
			})
		}
		body.lines.forEach((line, index) => {
			if (line.lineTotalMinor === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['lines', index, 'lineTotalMinor'],
					message: 'Required',
				})
			}
		})
	},
)
export type RecordDelivery = z.infer<typeof recordDeliverySchema>

export const deliveryLineSchema = z.object({
	id: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	quantity: z.number().int(),
	packs: z.number().nullable(),
	packName: z.string().nullable(),
	realWeightQuantity: z.number().int().nullable(),
	packPriceMinor: minorOut,
	lineTotalMinor: minorOut,
	/** Change in cost per base unit vs the item's previous last cost, in basis points. */
	priceChangeBp: z.number().int().nullable().optional(),
	// Phase 2 (optional).
	orderLineId: z.string().nullable().optional(),
	/** What the order said, base thousandths (omitted when not received against an order). */
	orderedQuantity: z.number().int().nullable().optional(),
	/** False for a quantity-only line until prices are confirmed. */
	priced: z.boolean().optional(),
})

export const deliverySummarySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	supplierId: z.string().nullable(),
	supplierName: z.string().nullable(),
	status: z.enum(['draft', 'received', 'cancelled']),
	invoiceNumber: z.string().nullable(),
	invoiceDate: isoDateSchema.nullable(),
	businessDate: isoDateSchema,
	source: z.enum(['operator', 'station']),
	receivedAt: z.number().int().nullable(),
	receivedBy: actorSchema,
	lineCount: z.number().int(),
	paid: z.boolean(),
	paidAt: z.number().int().nullable(),
	version: z.number().int(),
	linesTotalMinor: minorOut,
	vatMinor: minorOut,
	totalMinor: minorOut,
	currency: currencyOut,
	// Phase 2 (all optional: a region that predates them omits them).
	/** Quantities were recorded without prices; a person with the purchasing grant still has to confirm them. */
	pricesPending: z.boolean().optional(),
	/** The order this was received against. */
	orderId: z.string().nullable().optional(),
	orderNumber: z.number().int().nullable().optional(),
	hasPhoto: z.boolean().optional(),
	/** Recorded by a Station tablet more than 48 hours after it happened. */
	lateSync: z.boolean().optional(),
})
export type DeliverySummary = z.infer<typeof deliverySummarySchema>

export const deliveryDetailSchema = deliverySummarySchema.extend({
	zatcaReference: z.string().nullable(),
	lines: z.array(deliveryLineSchema),
	/**
	 * The invoice photo, as a short-lived read link into the region's own
	 * storage (5 minutes, `RECORDING_URL_TTL_SECONDS`). Present on
	 * `GET /deliveries/:id` only, never in lists. Phase 2.
	 */
	photo: z
		.object({
			url: z.string(),
			expiresAt: z.number().int(),
			contentType: z.string(),
		})
		.nullable()
		.optional(),
})
export type DeliveryDetail = z.infer<typeof deliveryDetailSchema>

/** `GET /deliveries?locationId=&supplierId=&unpaid=&limit=&cursor=` (newest first). */
export const listDeliveriesQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema.optional(),
		unpaid: z.stringbool().default(false),
	})
	.strict()

export const listDeliveriesResultSchema = z.object({
	deliveries: z.array(deliverySummarySchema),
	nextCursor: z.string().nullable(),
})

/** `POST /deliveries/:id/paid` (`update:inventory_purchasing:any`). */
export const markDeliveryPaidSchema = z
	.object({ expectedVersion: expectedVersionSchema, paid: z.boolean() })
	.strict()

/** `POST /deliveries/:id/cancel` (`update:inventory:any`): reverses its stock. */
export const cancelDeliverySchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()
