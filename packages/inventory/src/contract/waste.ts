import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import { wasteReasonSchema } from '../vocabulary.ts'
import {
	actorSchema,
	clientIdSchema,
	currencyOut,
	inventoryIdSchema,
	inventoryNoteSchema,
	isoDateSchema,
	listQuerySchema,
	minorOut,
	typedAmountSchema,
	unitRefSchema,
} from './common.ts'

/** Undo is allowed within this window, once, and posts a reversing entry. */
export const WASTE_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Why one Station waste entry was refused (`refused[].code` of the Station
 * answer), stable so the tablet can show it: `item_unknown`, `item_archived`,
 * `unit_mismatch` (the unit cannot measure the item), `quantity_invalid` (out
 * of range or not above zero), `idempotency_conflict` (the `clientId` was
 * already used for a different entry). A `clientId` stored before, or earlier
 * in the same request, is reported in `duplicates` with the first entry's id,
 * never as a refusal and never as a server error. A plain string on the wire:
 * treat an unknown code as "refused".
 */
export const WASTE_ENTRY_REFUSAL_CODES = [
	'item_unknown',
	'item_archived',
	'unit_mismatch',
	'quantity_invalid',
	'idempotency_conflict',
] as const
export type WasteEntryRefusalCode = (typeof WASTE_ENTRY_REFUSAL_CODES)[number]

/**
 * `POST /waste` (`update:inventory:any`): up to 50 entries (Station queues
 * send several). Phase 1 logs items; dishes come with recipes. The system
 * reasons (`cancelled_after_cooking`, `remade_at_till`) are refused here.
 */
export const wasteEntryInputSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		itemId: inventoryIdSchema,
		amount: typedAmountSchema.refine((a) => a > 0, 'Must be above zero'),
		unit: unitRefSchema,
		reason: wasteReasonSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()

export const logWasteSchema = z
	.object({ entries: z.array(wasteEntryInputSchema).min(1).max(50) })
	.strict()

export const logWasteResultSchema = z.object({
	accepted: z.array(
		z.object({
			clientId: z.string(),
			id: z.string(),
			quantity: z.number().int(),
			valueMinor: minorOut,
			currency: currencyOut,
		}),
	),
	duplicates: z.array(z.object({ clientId: z.string(), id: z.string() })),
})

/** `POST /waste/:id/undo` */
export const undoWasteSchema = z.object({ clientId: clientIdSchema }).strict()

export const wasteEntrySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	itemId: z.string().nullable(),
	itemName: z.string().nullable(),
	category: z.string().nullable(),
	baseUnit: inventoryBaseUnitSchema.nullable(),
	quantity: z.number().int(),
	reason: wasteReasonSchema,
	note: z.string().nullable(),
	actor: actorSchema,
	businessDate: isoDateSchema,
	createdAt: z.number().int(),
	/** Set on the original when someone undid it. */
	undoneAt: z.number().int().nullable(),
	/** Set on the reversing entry. */
	reversesId: z.string().nullable(),
	valueMinor: minorOut,
	currency: currencyOut,
})
export type WasteEntry = z.infer<typeof wasteEntrySchema>

/** `GET /waste?locationId=&from=&to=&reason=&limit=&cursor=` (newest first; reversing entries hidden). */
export const listWasteQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		from: isoDateSchema,
		to: isoDateSchema,
		reason: wasteReasonSchema.optional(),
	})
	.strict()

export const listWasteResultSchema = z.object({
	entries: z.array(wasteEntrySchema),
	nextCursor: z.string().nullable(),
})

/** `GET /waste/summary?locationId=&from=&to=` (undone entries excluded). */
export const wasteSummaryQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		from: isoDateSchema,
		to: isoDateSchema,
	})
	.strict()

const bucket = z.object({ count: z.number().int(), valueMinor: minorOut })

export const wasteSummarySchema = z.object({
	from: isoDateSchema,
	to: isoDateSchema,
	count: z.number().int(),
	valueMinor: minorOut,
	/** Deliveries received in the period, for "% of what you bought". */
	purchasesMinor: minorOut,
	currency: currencyOut,
	byReason: z.array(bucket.extend({ reason: wasteReasonSchema })),
	byCategory: z.array(bucket.extend({ category: z.string() })),
	byDay: z.array(bucket.extend({ date: isoDateSchema })),
	/** Top items by value (or count without the cost grant), max 5. */
	topItems: z.array(
		bucket.extend({ itemId: z.string(), itemName: z.string() }),
	),
})
export type WasteSummary = z.infer<typeof wasteSummarySchema>
