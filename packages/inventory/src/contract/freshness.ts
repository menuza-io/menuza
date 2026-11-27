import { z } from 'zod'
import { inventoryBaseUnitSchema } from '../units.ts'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	clientIdSchema,
	currencyOut,
	inventoryIdSchema,
	inventoryNameSchema,
	isoDateSchema,
	minorOut,
	positiveQuantitySchema,
	unitRefSchema,
} from './common.ts'

/**
 * Use-by dates and shelf life (#479, #523). Everything here is behind the
 * `inventory.use_by` flag and answers 403 `feature_disabled` without it.
 */

/** Longest shelf life: ten years, in hours. */
export const MAX_SHELF_LIFE_HOURS = 87_600

export const shelfLifeHoursSchema = z
	.number()
	.int()
	.min(1)
	.max(MAX_SHELF_LIFE_HOURS)

/** The name on a label beside the English one. Used on labels only. */
export const labelNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

export const storageNoteSchema = z
	.string()
	.trim()
	.max(120)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

/**
 * The freshness fields of an item, in create and edit. `trackByDate` makes
 * receiving ask for a date; `shelfLifeHours` derives one (and sets a made
 * item's use-by time on a label). Needs `inventory.use_by`.
 */
export const itemFreshnessInputShape = {
	trackByDate: z.boolean().optional(),
	shelfLifeHours: shelfLifeHoursSchema.nullable().optional(),
	storageNote: storageNoteSchema.nullable().optional(),
	nameAr: labelNameSchema.nullable().optional(),
}

export const itemFreshnessOutShape = {
	trackByDate: z.boolean().optional(),
	shelfLifeHours: z.number().int().nullable().optional(),
	storageNote: z.string().nullable().optional(),
	nameAr: z.string().nullable().optional(),
}

export const USE_BY_STATUSES = ['expired', 'today', 'soon', 'ok'] as const
export const useByStatusSchema = z.enum(USE_BY_STATUSES)

export const stockLotSchema = z.object({
	id: z.string(),
	/** `YYYY-MM-DD`, the last day to use it. */
	useByDate: isoDateSchema,
	/** What is left of the lot, base thousandths. */
	remaining: z.number().int(),
	/** Whole days from today (negative: past the date). */
	daysLeft: z.number().int(),
	status: useByStatusSchema,
	source: z.enum(['delivery', 'batch', 'confirm']),
})
export type StockLotOut = z.infer<typeof stockLotSchema>

/** `GET /items/:id/lots?locationId=`: stock by use-by date, oldest first. */
export const itemLotsSchema = z.object({
	itemId: z.string(),
	locationId: z.string(),
	date: isoDateSchema,
	trackByDate: z.boolean(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	onHand: z.number().int(),
	/** On hand the dates do not explain (used first). */
	undated: z.number().int(),
	lots: z.array(stockLotSchema),
})
export type ItemLots = z.infer<typeof itemLotsSchema>

/** One lot on Today's "Use first" and "Expired" lists. */
export const freshnessRowSchema = z.object({
	lotId: z.string(),
	itemId: z.string(),
	itemName: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	useByDate: isoDateSchema,
	remaining: z.number().int(),
	daysLeft: z.number().int(),
	status: useByStatusSchema,
	/** Cost grant only: what the remaining stock cost. */
	valueMinor: minorOut,
	currency: currencyOut,
})
export type FreshnessRow = z.infer<typeof freshnessRowSchema>

/** `GET /freshness?locationId=` (also inside `GET /today`). Twenty rows each, soonest date first. */
export const freshnessSchema = z.object({
	locationId: z.string(),
	date: isoDateSchema,
	expired: z.array(freshnessRowSchema).max(20),
	useFirst: z.array(freshnessRowSchema).max(20),
	expiredCount: z.number().int(),
	useFirstCount: z.number().int(),
})
export type Freshness = z.infer<typeof freshnessSchema>

/**
 * `POST /items/:id/lots/confirm`: "I checked the shelf, this is what is
 * there". Records the dates as the new baseline for the item at the location
 * (older dates stop counting). Quantities together may not exceed on hand; the
 * rest stays undated. A replayed `clientId` answers the first result.
 */
export const confirmLotsSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		lots: z
			.array(
				z
					.object({
						useByDate: isoDateSchema,
						quantity: positiveQuantitySchema,
					})
					.strict(),
			)
			.min(1)
			.max(30),
	})
	.strict()

/**
 * `POST /lots/:lotId/waste`: one tap from the expired list. Throws away
 * `quantity` of that lot (all that is left when absent) as waste with the
 * reason `expired`, and takes it from that date, not the oldest one.
 */
export const wasteLotSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		/** Base thousandths; at most what is left of the lot. */
		quantity: positiveQuantitySchema.optional(),
	})
	.strict()

export const wasteLotResultSchema = z.object({
	wasteId: z.string(),
	itemId: z.string(),
	quantity: z.number().int(),
	valueMinor: minorOut,
	currency: currencyOut,
	/** True when the same `clientId` was answered before. */
	duplicate: z.boolean(),
})

/** `GET /freshness?locationId=` and the item lots query. */
export const freshnessQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const lotParamsSchema = z.object({ lotId: inventoryIdSchema })

/** A label for a stock item shows when it was opened (#523). */
export const labelNameInputSchema = inventoryNameSchema

// ── Labels (#523) ───────────────────────────────────────────────────────────

export const labelCopiesSchema = z.number().int().min(1).max(5)

/** What the maker typed beside the label ("2 L", "3 portions"). */
export const labelQuantityTextSchema = z
	.string()
	.trim()
	.min(1)
	.max(24)
	.regex(/^[^\p{Cc}]*$/u, 'Invalid characters')

/** Asked for with a prep task done: print labels for the batch just made. */
export const doneLabelsSchema = z
	.object({
		copies: labelCopiesSchema.default(1),
		quantityLabel: labelQuantityTextSchema.optional(),
	})
	.strict()

/**
 * What a label says, structured. The tablet draws it itself (the browser's
 * print dialog) when no cloud label printer took the job.
 */
export const labelDataSchema = z.object({
	itemId: z.string(),
	nameEn: z.string(),
	/** The item's Arabic name; null when it has none. */
	nameAr: z.string().nullable(),
	kind: z.enum(['made', 'opened']),
	madeAt: z.number().int(),
	/** Null when the item has no shelf life. */
	useByAt: z.number().int().nullable(),
	/** Time in the location's zone, as printed. */
	madeAtLabel: z.string(),
	useByLabel: z.string().nullable(),
	madeBy: z.string().nullable(),
	quantityLabel: z.string().nullable(),
	storageNote: z.string().nullable(),
	timeZone: z.string(),
	copies: z.number().int(),
})
export type LabelData = z.infer<typeof labelDataSchema>

export const labelResultSchema = z.object({
	/** A cloud label printer at the location took the job (the tablet prints nothing). */
	printed: z.boolean(),
	/** Jobs queued (0 when no label printer is online). */
	jobs: z.number().int(),
	label: labelDataSchema,
})
export type LabelResult = z.infer<typeof labelResultSchema>

/**
 * `POST /pos/inventory/labels` (Station, behind `inventory.use_by`): a label
 * for any made item (made time) or stock item (opened time) from the Labels
 * screen. One `requestId` per press, so a retry never prints twice. `madeAt`
 * is the tablet's clock, accepted within the last two days.
 */
export const stationLabelSchema = z
	.object({
		requestId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		itemId: inventoryIdSchema,
		kind: z.enum(['made', 'opened']),
		copies: labelCopiesSchema.default(1),
		quantityLabel: labelQuantityTextSchema.optional(),
		madeAt: z.number().int().min(0).optional(),
	})
	.strict()
export type StationLabel = z.infer<typeof stationLabelSchema>
