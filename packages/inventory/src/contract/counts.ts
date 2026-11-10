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
 * One count being counted (`counting`) per location and list (list `null` =
 * everything): starting another answers 409 `count_in_progress` with that
 * count's id (Station joins it instead). A count waiting for review
 * (`in_review`) does not block a new start and is never joined: the new count
 * is its own count, and each approval posts only what its own entries show
 * (see `approveCountSchema` for the rule).
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
 * Why one entry was refused (`refused[].code`), stable so a client can show
 * it. A refusal is per entry with status 200: the others in the request are
 * saved. A `clientId` that was already stored (earlier request, or earlier in
 * the same request) is not a refusal: it is listed in `duplicates` and keeps
 * its first result, even when the count has been approved or cancelled since.
 *
 * - `count_closed`: the count is `approved` or `cancelled`. (`counting` and
 *   `in_review` both take entries; the review reads them live until approval.)
 * - `item_unknown`: no such item. `item_archived`: archived, not countable.
 * - `area_unknown`: no such (or an archived) storage area at the location.
 * - `unit_mismatch`: the unit cannot measure the item.
 * - `quantity_invalid`: the amount is out of range.
 *
 * `code` stays a plain string on the wire, so a newer region may add codes
 * without breaking an older client's parse; treat an unknown code as "refused".
 */
export const COUNT_ENTRY_REFUSAL_CODES = [
	'count_closed',
	'item_unknown',
	'item_archived',
	'area_unknown',
	'unit_mismatch',
	'quantity_invalid',
] as const
export type CountEntryRefusalCode = (typeof COUNT_ENTRY_REFUSAL_CODES)[number]

/**
 * `POST /counts/:id/entries`: up to 200 entries.
 *
 * Live entries: for each counter the latest entry per item, area and unit
 * slot wins, `amount: null` clears that slot, and the counted quantity of an
 * item is the sum of every live entry. A unit slot is one named unit (a box,
 * a crate) or, for all standard units (g, kg, oz, lb, ml, l, ...) together,
 * one shared "standard" slot. So "2 boxes and 3 kg" are two live entries and
 * add up, but 5 kg followed by 5000 g (or 5 kg followed by 6 kg) is one
 * measurement corrected: the later entry replaces the earlier one and the item
 * is never double counted by switching between standard units. Switching a
 * row between a named unit and a standard unit (or between two named units)
 * keeps both live, so a client that switches the unit of a row it already
 * sent must send `amount: null` for the old unit first.
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
	/** `code` is one of `COUNT_ENTRY_REFUSAL_CODES` (a plain string on the wire). */
	refused: z.array(z.object({ clientId: z.string(), code: z.string() })),
})

/** `POST /counts/:id/send` (counting → in review), `/reopen` (in review → counting), `/cancel`: `versionOnlySchema`. */

/** Why a review line needs a look. */
export const REVIEW_FLAGS = ['not_counted', 'big_difference'] as const
export const reviewFlagSchema = z.enum(REVIEW_FLAGS)

/**
 * `GET /counts/:id/review`. `expected` is the stock ledger AS OF the moment the
 * item was counted (its latest live entry's time): last count + deliveries −
 * waste ± adjustments − sales up to that instant, never the live on-hand.
 * Deliveries, sales or waste that happened after an item was counted are not
 * part of its `expected` and approval keeps them. An item nobody counted shows
 * the live on-hand. Only lines needing a look are listed in `lines`; the rest
 * are summarised in `matching`.
 */
/**
 * What moved an item between the last approved count at the location and the
 * moment this item was counted, in base thousandths, so "expected" explains
 * itself: "49 kg = last count + 20 delivered - 18 used by sales - 3 wasted".
 * `used` is sales and batches made (positive), `delivered` includes transfers
 * in and batches made, `adjusted` is the signed net of adjustments. No money.
 * Movements after the item was counted are not shown (they are not part of
 * "expected"; approval keeps them).
 */
export const countReviewMovementsSchema = z.object({
	/** The instant the last approved count was taken (its latest entry); null when there was none. */
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
 * counted quantity differs from the ledger as of that item's latest entry
 * (counted − on-hand-as-of-then). The movement is stamped with that instant,
 * so movements recorded after it (a delivery at 14:00 after a 10:00 count) are
 * kept and the stock ends at counted + what moved since. An item whose
 * ledger already holds a later count's adjustment is skipped (the later
 * measurement stands). Uncounted items default to `keep`; `zero` posts minus
 * the on-hand at approval time. Counts in review are independent: approving
 * one never needs the others to be closed.
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
