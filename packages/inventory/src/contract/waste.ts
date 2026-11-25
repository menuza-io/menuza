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

/** One option chosen on a dish (size and extras change the ingredients like a sale does). */
export const wasteDishOptionSchema = z
	.object({
		optionId: inventoryIdSchema,
		quantity: z.number().int().min(1).max(20).optional(),
		half: z.enum(['whole', 'left', 'right']).nullable().optional(),
	})
	.strict()

export const wasteDishSchema = z.object({
	groupId: z.string(),
	menuItemId: z.string(),
	variantId: z.string().nullable(),
	options: z.array(wasteDishOptionSchema),
	/** How many dishes were thrown away. */
	dishes: z.number().int(),
	/** `recipe`: ingredient rows. `typed`: no recipe, the dish's typed cost was used. */
	basis: z.enum(['recipe', 'typed']),
	/** Ingredient rows in the group. */
	ingredients: z.number().int(),
})
export type WasteDish = z.infer<typeof wasteDishSchema>

export const WASTE_CORRECTION_KINDS = ['reverse', 'quantity'] as const
export const WASTE_CORRECTION_STOCK_EFFECTS = [
	'applied',
	'covered_by_count',
	'none',
] as const

export const wasteCorrectionSchema = z.object({
	id: z.string(),
	kind: z.enum(WASTE_CORRECTION_KINDS),
	/** The quantity before and after this correction (0 after: reversed). Base thousandths; dishes for a dish group. */
	previousQuantity: z.number().int(),
	newQuantity: z.number().int(),
	/** Whether stock moved, or an approved count already covered the entry. */
	stockEffect: z.enum(WASTE_CORRECTION_STOCK_EFFECTS),
	reason: z.string(),
	actor: actorSchema,
	createdAt: z.number().int(),
	/** The waste figure's change in money (cost grant). */
	valueDeltaMinor: minorOut,
	currency: currencyOut,
})
export type WasteCorrection = z.infer<typeof wasteCorrectionSchema>

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
	/**
	 * A whole dish logged as waste (#517): the entry is the group (`id` is the
	 * group id, `quantity` and `itemId` stand for the ingredients it adds up
	 * to), and the log reads "2 x <dish>". The App and Station join the dish
	 * name from the menu; the region keeps ids only.
	 */
	dish: wasteDishSchema.optional(),
	/**
	 * Later corrections of this entry (#522), oldest first. The original
	 * `quantity` and `valueMinor` never change; `currentQuantity` and
	 * `currentValueMinor` are what the entry counts for now.
	 */
	corrections: z.array(wasteCorrectionSchema).optional(),
	currentQuantity: z.number().int().optional(),
	currentValueMinor: minorOut,
	/**
	 * An approved count at this place, taken after the entry and covering its
	 * item, already reflects it: a correction then changes the waste figures
	 * only, never stock (#522).
	 */
	countedSince: z.boolean().optional(),
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

// ── A whole dish as waste (#517) ────────────────────────────────────────────

/**
 * `POST /waste/dishes` (`update:inventory:any`, behind `inventory.recipes`):
 * `quantity` of one dish, with the size and options chosen, written as one
 * waste row per ingredient using the recipe in force NOW (options change the
 * ingredients like a sale does), grouped under the dish. A dish with no
 * recipe but a typed cost is logged at that cost; one with neither is refused
 * (409 `recipe_missing`: "Add a recipe first"). The same `clientId` answers
 * the first result (`duplicate`). Reasons are the pickable ones; Station's
 * Kitchen path keeps `cancelled_after_cooking` through its own route.
 */
export const logWasteDishSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		menuItemId: inventoryIdSchema,
		variantId: inventoryIdSchema.nullable().optional(),
		options: z.array(wasteDishOptionSchema).max(30).optional(),
		quantity: z.number().int().min(1).max(50),
		reason: wasteReasonSchema,
		note: inventoryNoteSchema.optional(),
	})
	.strict()
export type LogWasteDish = z.infer<typeof logWasteDishSchema>

export const logWasteDishResultSchema = z.object({
	/** The group id: undo and correct by it. */
	id: z.string(),
	entries: z.number().int(),
	basis: z.enum(['recipe', 'typed']),
	duplicate: z.boolean(),
	valueMinor: minorOut,
	currency: currencyOut,
})
export type LogWasteDishResult = z.infer<typeof logWasteDishResultSchema>

// ── Later correction (#522) ─────────────────────────────────────────────────

/**
 * `POST /waste/:id/correct` (`update:inventory:any`, never Station): reverse an
 * entry (`kind: 'reverse'`) or change its quantity (`kind: 'quantity'`: for a
 * stock item `amount` and `unit`, for a dish group `dishes`), with a reason.
 * The original row stays; a correction is added, and unless an approved count
 * already covers the entry, stock moves by the difference. A reversed or
 * undone entry cannot be corrected again (409 `already_reversed` /
 * `already_undone`), and a corrected one cannot be undone
 * (409 `already_corrected`). `clientId` makes a repeat answer the first.
 */
export const correctWasteSchema = z
	.object({
		clientId: clientIdSchema,
		kind: z.enum(WASTE_CORRECTION_KINDS),
		amount: typedAmountSchema.optional(),
		unit: unitRefSchema.optional(),
		dishes: z.number().int().min(1).max(50).optional(),
		reason: z.string().trim().min(3).max(300),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.kind === 'reverse') {
			if (
				body.amount !== undefined ||
				body.unit !== undefined ||
				body.dishes !== undefined
			) {
				ctx.addIssue({
					code: 'custom',
					message: 'A reversal takes no quantity',
				})
			}
			return
		}
		const item = body.amount !== undefined && body.unit !== undefined
		const dish = body.dishes !== undefined
		if (item === dish) {
			ctx.addIssue({
				code: 'custom',
				path: ['amount'],
				message: 'Give an amount and a unit, or a number of dishes',
			})
		}
		if (item && !(body.amount! > 0)) {
			ctx.addIssue({
				code: 'custom',
				path: ['amount'],
				message: 'Must be above zero',
			})
		}
	})
export type CorrectWaste = z.infer<typeof correctWasteSchema>
