import { z } from 'zod'
import {
	currencyOut,
	isoDateSchema,
	minorOut,
	unitRefSchema,
} from './common.ts'

/**
 * `GET /today?locationId=`: everything the Today page shows, computed in the
 * region by rules (no generated prose). Money fields are omitted without the
 * cost grant; the page then shows quantity metrics.
 */

export const FOOD_COST_STATES = ['ok', 'need_two_counts', 'no_sales'] as const

export const foodCostSchema = z.object({
	state: z.enum(FOOD_COST_STATES),
	/** Between the two most recent approved counts. */
	from: isoDateSchema.nullable(),
	to: isoDateSchema.nullable(),
	targetBp: z.number().int(),
	bp: z.number().int().nullable().optional(),
	openingMinor: minorOut,
	purchasesMinor: minorOut,
	closingMinor: minorOut,
	salesMinor: minorOut,
})

/** One "needs attention" row: one sentence and one action in the App. */
export const attentionItemSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('low_stock'),
		itemId: z.string(),
		itemName: z.string(),
		onHand: z.number().int(),
		countUnit: unitRefSchema.nullable(),
		baseUnit: z.enum(['g', 'ml', 'piece']),
		status: z.enum(['low', 'out']),
		supplierId: z.string().nullable(),
		supplierName: z.string().nullable(),
		/** How many more items are low beyond this one (shown as "and 4 more"). */
		more: z.number().int(),
		valueAtStakeMinor: minorOut,
	}),
	z.object({ kind: z.literal('count_due'), date: isoDateSchema }),
	z.object({
		kind: z.literal('count_in_progress'),
		countId: z.string(),
		itemsCounted: z.number().int(),
		itemTotal: z.number().int(),
	}),
	z.object({ kind: z.literal('count_in_review'), countId: z.string() }),
	z.object({
		kind: z.literal('price_rise'),
		itemId: z.string(),
		itemName: z.string(),
		changeBp: z.number().int(),
		deliveryId: z.string(),
		supplierName: z.string().nullable(),
	}),
	z.object({
		kind: z.literal('unpaid_deliveries'),
		count: z.number().int(),
		amountMinor: minorOut,
		currency: currencyOut,
	}),
])
export type AttentionItem = z.infer<typeof attentionItemSchema>

export const todaySchema = z.object({
	locationId: z.string(),
	date: isoDateSchema,
	metrics: z.object({
		stockValueMinor: minorOut,
		lastCountAt: z.number().int().nullable(),
		foodCost: foodCostSchema.optional(),
		wasteWeekCount: z.number().int(),
		wasteWeekMinor: minorOut,
		/** Waste as a share of deliveries this week, basis points. */
		wasteWeekShareBp: z.number().int().nullable().optional(),
		lowItems: z.number().int(),
		outItems: z.number().int(),
		currency: currencyOut,
	}),
	/** At most five, most money at stake first. */
	attention: z.array(attentionItemSchema).max(5),
	/** The next seven days: counts (from the count day) and expected deliveries (supplier days). */
	week: z.array(
		z.object({
			date: isoDateSchema,
			kind: z.enum(['count', 'delivery']),
			supplierId: z.string().nullable(),
			supplierName: z.string().nullable(),
		}),
	),
	/** Setup checklist facts (as `GET /status`). */
	setup: z.object({
		items: z.number().int(),
		storageAreas: z.number().int(),
		approvedCounts: z.number().int(),
		deliveries: z.number().int(),
	}),
})
export type Today = z.infer<typeof todaySchema>
