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

/** `POST /suppliers` and `PATCH /suppliers/:id` (`update:inventory_purchasing:any`). */
export const supplierInputSchema = z
	.object({
		name: inventoryNameSchema,
		contactName: optionalText(80),
		phone: optionalText(40),
		email: z.email().max(200).nullable().optional(),
		orderChannel: z.enum(SUPPLIER_ORDER_CHANNELS).default('phone'),
		/** Days they deliver, 0 = Sunday … 6 = Saturday. */
		deliveryDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
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

export const createSupplierSchema = supplierInputSchema
	.extend({ clientId: clientIdSchema })
	.strict()

export const updateSupplierSchema = supplierInputSchema
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

/** `GET /suppliers?includeArchived=` → `{ suppliers, unpaidMinor?, currency? }` (sorted by name). */
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

/** `POST /suppliers/:id/products` (`update:inventory_purchasing:any`). */
export const supplierProductInputSchema = z
	.object({
		itemId: inventoryIdSchema,
		packName: inventoryNameSchema,
		packBaseQuantity: positiveQuantitySchema,
		priceMinor: z.number().int().min(0),
		pricedByWeight: z.boolean().default(false),
		sku: optionalText(60),
		preferred: z.boolean().default(false),
	})
	.strict()

/** `PATCH /supplier-products/:id`; archive with `versionOnlySchema`. */
export const updateSupplierProductSchema = supplierProductInputSchema
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
		lineTotalMinor: z.number().int().min(0),
		/** Real weight (base thousandths) when the line is priced by weight. */
		realWeightQuantity: positiveQuantitySchema.nullable().optional(),
	})
	.strict()

/**
 * `POST /deliveries` (`update:inventory:any`). Posts a `delivery` movement per
 * line, updates last and average cost, and remembers pack prices.
 */
export const recordDeliverySchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema.nullable(),
		invoiceNumber: optionalText(60),
		invoiceDate: isoDateSchema.nullable().optional(),
		currency: currencySchema,
		vatMinor: z.number().int().min(0).nullable().optional(),
		/** The invoice's grand total, to compare with the lines. */
		totalMinor: z.number().int().min(0).nullable().optional(),
		zatcaReference: optionalText(200),
		paid: z.boolean().default(false),
		lines: z.array(deliveryLineInputSchema).min(1).max(200),
	})
	.strict()
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
})
export type DeliverySummary = z.infer<typeof deliverySummarySchema>

export const deliveryDetailSchema = deliverySummarySchema.extend({
	zatcaReference: z.string().nullable(),
	lines: z.array(deliveryLineSchema),
})
export type DeliveryDetail = z.infer<typeof deliveryDetailSchema>

/** `GET /deliveries?locationId=&supplierId=&unpaid=&limit=&cursor=` (newest first). */
export const listDeliveriesQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		supplierId: inventoryIdSchema.optional(),
		unpaid: z.coerce.boolean().default(false),
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
