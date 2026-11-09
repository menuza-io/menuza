import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import { COUNT_STATUSES } from '../vocabulary.ts'
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
	typedAmountSchema,
	unitRefSchema,
} from './common.ts'
import { itemUnitSchema } from './items.ts'

export const countStatusSchema = z.enum(COUNT_STATUSES)

/**
 * One open count per location and list (list `null` = everything): starting
 * another answers 409 `count_in_progress` with the open count's id.
 */
/** `POST /counts` (`update:inventory:any`). */
export const startCountSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		listId: inventoryIdSchema.nullable(),
	})
	.strict()

export const countSummarySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	listId: z.string().nullable(),
	listName: z.string().nullable(),
	status: countStatusSchema,
	businessDate: isoDateSchema,
	startedBy: actorSchema,
	itemTotal: z.number().int(),
	itemsCounted: z.number().int(),
	/** Counters who added entries (operators and staff). */
	counters: z.array(actorSchema),
	/** Net money difference posted (approved) or pending (in review). */
	differenceValueMinor: minorOut,
	currency: currencyOut,
	sentForReviewAt: z.number().int().nullable(),
	approvedAt: z.number().int().nullable(),
	approvedBy: actorSchema.nullable(),
	cancelledAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	version: z.number().int(),
})
export type CountSummary = z.infer<typeof countSummarySchema>

/** `GET /counts?locationId=&status=&limit=&cursor=` (newest first). */
export const listCountsQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		status: z.enum(['open', 'closed', 'all']).default('all'),
	})
	.strict()

export const listCountsResultSchema = z.object({
	counts: z.array(countSummarySchema),
	nextCursor: z.string().nullable(),
})

/**
 * `GET /counts/:id`: the counting sheet. Areas in walking order, items in shelf
 * order; items in no area come last under `areaId: null`. `quantity` is the
 * sum over counters of each counter's latest entry for that item and area;
 * `null` when nobody counted it there yet. Never includes expected figures.
 */
export const countSheetItemSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	quantity: z.number().int().nullable(),
	/** What this caller last typed here, to show back in their field. */
	mine: z.object({ amount: z.number(), unit: unitRefSchema }).nullable(),
})

export const countSheetSchema = z.object({
	count: countSummarySchema,
	areas: z.array(
		z.object({
			areaId: z.string().nullable(),
			name: z.string().nullable(),
			items: z.array(countSheetItemSchema),
		}),
	),
})
export type CountSheet = z.infer<typeof countSheetSchema>

/**
 * `POST /counts/:id/entries`: up to 200 entries. Each counter's latest entry
 * per item and area wins; `amount: null` clears that counter's entry. Entries
 * on a count that is no longer `counting` answer per entry with
 * `count_closed`. A replayed `clientId` is reported in `duplicates`.
 */
export const countEntrySchema = z
	.object({
		clientId: clientIdSchema,
		itemId: inventoryIdSchema,
		areaId: inventoryIdSchema.nullable(),
		amount: typedAmountSchema.nullable(),
		unit: unitRefSchema,
	})
	.strict()

export const countEntriesSchema = z
	.object({ entries: z.array(countEntrySchema).min(1).max(200) })
	.strict()

export const countEntriesResultSchema = z.object({
	accepted: z.array(
		z.object({ clientId: z.string(), quantity: z.number().int().nullable() }),
	),
	duplicates: z.array(z.string()),
	refused: z.array(z.object({ clientId: z.string(), code: z.string() })),
})

/** `POST /counts/:id/send` (counting → in review), `/reopen` (in review → counting), `/cancel`: `versionOnlySchema`. */

/** Why a review line needs a look. */
export const REVIEW_FLAGS = ['not_counted', 'big_difference'] as const
export const reviewFlagSchema = z.enum(REVIEW_FLAGS)

/**
 * `GET /counts/:id/review`. `expected` is on hand from the stock ledger
 * (last count + deliveries − waste ± adjustments, and later − sales). Only
 * lines needing a look are listed in `lines`; the rest are summarised in
 * `matching`.
 */
/**
 * What moved an item since the last approved count at the location, in base
 * thousandths, so "expected" explains itself: "49 kg = last count + 20
 * delivered - 18 used by sales - 3 wasted". `used` is sales and batches made
 * (positive), `delivered` includes transfers in and batches made, `adjusted`
 * is the signed net of adjustments. No money.
 */
export const countReviewMovementsSchema = z.object({
	/** When the last approved count was approved; null when there was none. */
	since: z.number().int().nullable(),
	delivered: z.number().int(),
	used: z.number().int(),
	wasted: z.number().int(),
	adjusted: z.number().int(),
})
export type CountReviewMovements = z.infer<typeof countReviewMovementsSchema>

export const countReviewLineSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	counted: z.number().int().nullable(),
	expected: z.number().int(),
	difference: z.number().int().nullable(),
	flag: reviewFlagSchema,
	movements: countReviewMovementsSchema.optional(),
	differenceValueMinor: minorOut,
	currency: currencyOut,
})

export const countReviewSchema = z.object({
	count: countSummarySchema,
	lines: z.array(countReviewLineSchema),
	matching: z.number().int(),
	notCounted: z.number().int(),
	/** Net money difference if approved now, uncounted kept as before. */
	differenceValueMinor: minorOut,
	currency: currencyOut,
})
export type CountReview = z.infer<typeof countReviewSchema>

/**
 * `POST /counts/:id/approve` (needs `update:inventory:any` and
 * `read:inventory_cost:any`). Posts one `count` movement per item whose
 * counted quantity differs from on hand. Uncounted items default to `keep`.
 */
export const approveCountSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		uncounted: z
			.record(inventoryIdSchema, z.enum(['keep', 'zero']))
			.default({}),
		notes: z.record(inventoryIdSchema, inventoryNoteSchema).default({}),
	})
	.strict()
