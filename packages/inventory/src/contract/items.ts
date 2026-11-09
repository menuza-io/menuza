import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema, namedUnitSchema } from '../units.ts'
import {
	adjustmentReasonSchema,
	inventoryCategorySchema,
	inventoryItemKindSchema,
	movementKindSchema,
} from '../vocabulary.ts'
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
	nonNegativeQuantitySchema,
	positiveQuantitySchema,
	quantitySchema,
	unitRefSchema,
} from './common.ts'

/** Stock status at a location: out at or below zero, low below "order more when below". */
export const STOCK_STATUSES = ['ok', 'low', 'out'] as const
export type StockStatus = (typeof STOCK_STATUSES)[number]
export const stockStatusSchema = z.enum(STOCK_STATUSES)

// ── Places (item × location) ────────────────────────────────────────────────

export const itemPlaceInputSchema = z
	.object({
		/** How the item is counted here: a standard unit or `unit:<id>`. */
		countUnit: unitRefSchema,
		/** Storage areas at this location, in no particular order. */
		areaIds: z.array(inventoryIdSchema).max(10),
		/** "Order more when below", in base thousandths. */
		orderBelowQuantity: nonNegativeQuantitySchema.nullable(),
		/** "Fill up to", in base thousandths. */
		fillUpToQuantity: nonNegativeQuantitySchema.nullable(),
	})
	.strict()

/** `PUT /items/:id/places/:locationId` (`update:inventory:any`). */
export const putItemPlaceSchema = itemPlaceInputSchema
	.extend({ expectedVersion: expectedVersionSchema })
	.strict()

export const itemPlaceSchema = z.object({
	locationId: inventoryLocationIdSchema,
	countUnit: unitRefSchema,
	areaIds: z.array(z.string()),
	orderBelowQuantity: z.number().int().nullable(),
	fillUpToQuantity: z.number().int().nullable(),
	version: z.number().int(),
})

export const itemUnitSchema = z.object({
	id: z.string(),
	name: z.string(),
	baseQuantity: z.number().int(),
	/** A used unit's size never changes. */
	used: z.boolean(),
	archived: z.boolean(),
})

// ── Create / edit ───────────────────────────────────────────────────────────

/** First supplier product, created with the item ("How you buy it"). */
export const newItemSupplierProductSchema = z
	.object({
		supplierId: inventoryIdSchema,
		packName: inventoryNameSchema,
		packBaseQuantity: positiveQuantitySchema,
		priceMinor: z.number().int().min(0),
		currency: z.string().regex(/^[A-Z]{3}$/),
		pricedByWeight: z.boolean(),
	})
	.strict()

/** `POST /items` (`update:inventory:any`; the supplier product also needs `update:inventory_purchasing:any`). */
export const createItemSchema = z
	.object({
		clientId: clientIdSchema,
		name: inventoryNameSchema,
		category: inventoryCategorySchema,
		kind: inventoryItemKindSchema,
		baseUnit: inventoryBaseUnitSchema,
		notes: inventoryNoteSchema.optional(),
		units: z.array(namedUnitSchema).max(12).optional(),
		/**
		 * Where it is kept and how it is counted at one location. `countUnit`
		 * may name a unit in `units` by its position as `new:<index>`.
		 */
		place: itemPlaceInputSchema
			.extend({
				locationId: inventoryLocationIdSchema,
				countUnit: z.union([
					unitRefSchema,
					z.string().regex(/^new:\d{1,2}$/, 'Invalid unit'),
				]),
			})
			.strict()
			.optional(),
		supplierProduct: newItemSupplierProductSchema.optional(),
	})
	.strict()
export type CreateItem = z.infer<typeof createItemSchema>

/** `PATCH /items/:id`. `baseUnit` is refused (`unit_in_use`) once the item has stock movements. */
export const updateItemSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		name: inventoryNameSchema.optional(),
		category: inventoryCategorySchema.optional(),
		baseUnit: inventoryBaseUnitSchema.optional(),
		notes: inventoryNoteSchema.nullable().optional(),
	})
	.strict()

/** `POST /items/:id/archive` and `/restore`. */
export const versionOnlySchema = z
	.object({ expectedVersion: expectedVersionSchema })
	.strict()

/** `POST /items/:id/units`. Unit names are unique per item. */
export const createItemUnitSchema = namedUnitSchema

/** `POST /items/bulk`: starter lists and pasted spreadsheets (max 200). */
export const bulkCreateItemsSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		/** Existing names (case-insensitive) are skipped instead of refused. */
		items: z
			.array(
				z
					.object({
						name: inventoryNameSchema,
						category: inventoryCategorySchema,
						kind: inventoryItemKindSchema,
						baseUnit: inventoryBaseUnitSchema,
						countUnit: unitRefSchema.optional(),
						/** Storage area by name; created at the location when missing. */
						areaName: inventoryNameSchema.optional(),
						/** Optional starting cost per base unit (micro-minor), for value before the first delivery. */
						costMicro: z.number().int().min(0).optional(),
						currency: z
							.string()
							.regex(/^[A-Z]{3}$/)
							.optional(),
					})
					.strict(),
			)
			.min(1)
			.max(200),
	})
	.strict()

export const bulkCreateItemsResultSchema = z.object({
	created: z.array(z.object({ id: z.string(), name: z.string() })),
	skipped: z.array(
		z.object({ name: z.string(), reason: z.enum(['exists', 'duplicate']) }),
	),
	areasCreated: z.number().int(),
})

/** `POST /items/:id/adjust`: a by-hand stock change with a reason. */
export const adjustStockSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		/** Signed change in base thousandths (not zero). */
		quantity: quantitySchema.refine((q) => q !== 0, 'Change must not be zero'),
		reason: adjustmentReasonSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()

// ── Reads ───────────────────────────────────────────────────────────────────

/** `GET /items?locationId=&q=&category=&areaId=&status=&includeArchived=&limit=&cursor=` */
export const listItemsQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		q: z.string().trim().max(80).optional(),
		category: z.string().max(60).optional(),
		areaId: inventoryIdSchema.optional(),
		status: z.enum(['all', 'low', 'out', 'attention']).default('all'),
		includeArchived: z.coerce.boolean().default(false),
	})
	.strict()

export const stockItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	category: z.string(),
	kind: inventoryItemKindSchema,
	baseUnit: inventoryBaseUnitSchema,
	archived: z.boolean(),
	version: z.number().int(),
	/** On hand at the requested location, base thousandths (may be negative). */
	onHand: z.number().int(),
	countUnit: unitRefSchema.nullable(),
	/** The item's named units, so the client can show the count unit. */
	units: z.array(itemUnitSchema),
	areaIds: z.array(z.string()),
	orderBelowQuantity: z.number().int().nullable(),
	fillUpToQuantity: z.number().int().nullable(),
	status: stockStatusSchema,
	lastCountedAt: z.number().int().nullable(),
	costMicro: z.number().int().nullable().optional(),
	valueMinor: minorOut,
	currency: currencyOut,
})
export type StockItem = z.infer<typeof stockItemSchema>

export const listItemsResultSchema = z.object({
	items: z.array(stockItemSchema),
	total: z.number().int(),
	nextCursor: z.string().nullable(),
	/** Sum of `valueMinor` across every matching item (cost grant only). */
	totalValueMinor: minorOut,
	currency: currencyOut,
})

export const itemSupplierProductSchema = z.object({
	id: z.string(),
	supplierId: z.string(),
	supplierName: z.string(),
	packName: z.string(),
	packBaseQuantity: z.number().int(),
	priceMinor: minorOut,
	currency: currencyOut,
	pricedByWeight: z.boolean(),
	preferred: z.boolean(),
})

/** `GET /items/:id?locationId=` */
export const itemDetailSchema = stockItemSchema.extend({
	notes: z.string().nullable(),
	places: z.array(itemPlaceSchema),
	onHandByLocation: z.array(
		z.object({ locationId: z.string(), onHand: z.number().int() }),
	),
	suppliers: z.array(itemSupplierProductSchema),
	cost: z
		.object({
			lastCostMicro: z.number().int().nullable(),
			lastPricedAt: z.number().int().nullable(),
			avgCostMicro: z.number().int().nullable(),
			currency: z.string(),
			/** Delivered cost per base unit over time, newest last (max 24). */
			history: z.array(
				z.object({ at: z.number().int(), costMicro: z.number().int() }),
			),
		})
		.nullable()
		.optional(),
	hasMovements: z.boolean(),
})
export type ItemDetail = z.infer<typeof itemDetailSchema>

/** `GET /items/:id/movements?locationId=&limit=&cursor=` (newest first). */
export const listMovementsQuerySchema = listQuerySchema
	.extend({ locationId: inventoryLocationIdSchema })
	.strict()

export const movementSchema = z.object({
	id: z.string(),
	kind: movementKindSchema,
	quantity: z.number().int(),
	reason: z.string().nullable(),
	note: z.string().nullable(),
	sourceType: z.string(),
	sourceId: z.string().nullable(),
	businessDate: isoDateSchema,
	actor: actorSchema,
	valueMinor: minorOut,
	currency: currencyOut,
	createdAt: z.number().int(),
})

export const listMovementsResultSchema = z.object({
	movements: z.array(movementSchema),
	nextCursor: z.string().nullable(),
})
