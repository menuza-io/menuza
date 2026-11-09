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
	/** Phase 2: an order for this supplier should go out before its cut-off. */
	z.object({
		kind: z.literal('order_cutoff'),
		supplierId: z.string(),
		supplierName: z.string(),
		/** Local date and time (the location's time zone) the order must be sent by. */
		cutoffDate: isoDateSchema,
		cutoffTime: z.string(),
		expectedDate: isoDateSchema,
		itemCount: z.number().int(),
		/** The draft already started for this supplier, when there is one. */
		draftOrderId: z.string().nullable(),
	}),
	/** Phase 2: an open order is due today (or overdue). */
	z.object({
		kind: z.literal('delivery_expected'),
		orderId: z.string(),
		supplierName: z.string(),
		expectedDate: isoDateSchema,
		overdue: z.boolean(),
	}),
	/** Phase 2: a delivery was received without prices (Station) and waits for confirmation. */
	z.object({
		kind: z.literal('prices_pending'),
		deliveryId: z.string(),
		supplierName: z.string().nullable(),
		lineCount: z.number().int(),
	}),
	/** Phase 3: dishes taken off the menu because an ingredient ran out (auto sold out). */
	z.object({
		kind: z.literal('sold_out_by_stock'),
		/** Dishes and options off the menu now at this location. */
		count: z.number().int(),
		itemId: z.string(),
		itemName: z.string(),
		/** How many more items ran out beyond this one. */
		more: z.number().int(),
	}),
	/** Phase 3: a till voided a dish as "out of stock" this week (`menuItemId` is a menu id; the App joins the name). */
	z.object({
		kind: z.literal('ran_out_at_till'),
		menuItemId: z.string(),
		times: z.number().int(),
		/** How many more dishes ran out at the till beyond this one. */
		more: z.number().int(),
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
		/** Phase 2 ("To order: 9 items, 2 suppliers"); omitted while `inventory.purchasing` is off. */
		toOrderItems: z.number().int().optional(),
		toOrderSuppliers: z.number().int().optional(),
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
			/** Phase 2: the open order this delivery is expected for. */
			orderId: z.string().nullable().optional(),
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
