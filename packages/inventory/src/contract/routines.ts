import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { wasteReasonSchema } from '../vocabulary.ts'
import {
	currencyOut,
	expectedVersionSchema,
	isoDateSchema,
	listQuerySchema,
	minorOut,
} from './common.ts'

/**
 * Ready-made back-of-house routines (#529), behind `inventory.routines`. A
 * routine is a template a manager turns on or off per location. It runs on the
 * region's own tick (no new cron slot), generates its summary in the region and
 * keeps a record of every run and what it did. A routine only DRAFTS and TELLS:
 * it never sends an order to a supplier or a message to staff; every alert goes
 * to a manager, who decides.
 *
 * - `count_low_stock`: after a count is approved, draft an order for each
 *   supplier with low items (none where a draft already exists) and ask the
 *   manager to review. Run key: the count.
 * - `weekly_waste`: every Monday morning, last week's waste: top five items and
 *   the reasons. Run key: the Monday.
 * - `morning_brief`: every morning, what the day holds: deliveries due, counts
 *   due, prep, who is working, items running out, and (with `inventory.use_by`)
 *   what to use first. Run key: the day.
 * - `supplier_cutoff`: before a supplier's cut-off, a reminder when no order
 *   has been drafted. Run key: the day and the supplier.
 */

export const ROUTINE_KEYS = [
	'count_low_stock',
	'weekly_waste',
	'morning_brief',
	'supplier_cutoff',
] as const
export const routineKeySchema = z.enum(ROUTINE_KEYS)
export type RoutineKey = z.infer<typeof routineKeySchema>

/** The templates a manager can turn on, with what each needs. */
export const ROUTINE_TEMPLATES: Record<
	RoutineKey,
	{ needsPurchasing: boolean; trigger: 'count_approved' | 'weekly' | 'daily' | 'before_cutoff' }
> = {
	count_low_stock: { needsPurchasing: true, trigger: 'count_approved' },
	weekly_waste: { needsPurchasing: false, trigger: 'weekly' },
	morning_brief: { needsPurchasing: false, trigger: 'daily' },
	supplier_cutoff: { needsPurchasing: true, trigger: 'before_cutoff' },
}

/** How long before a supplier's cut-off the reminder is due (minutes). */
export const CUTOFF_REMINDER_MINUTES = 120
/** The morning routines wait for this local time (as the daily digest does). */
export const ROUTINE_MORNING_FROM_TIME = '07:00'

export const ROUTINE_RUN_STATUSES = ['done', 'nothing_to_do', 'failed'] as const

const draftedOrderSchema = z.object({
	orderId: z.string(),
	number: z.number().int(),
	supplierName: z.string(),
	lineCount: z.number().int(),
})

export const countLowStockSummarySchema = z.object({
	countId: z.string(),
	drafted: z.array(draftedOrderSchema),
	/** Suppliers with low items that already had a draft: left alone. */
	draftExisted: z.array(z.object({ supplierName: z.string(), orderId: z.string() })),
	/** Low items with no supplier product: nobody to order from. */
	unsourced: z.number().int(),
	/** Why nothing was drafted, when nothing was. */
	reason: z.enum(['no_low_items', 'purchasing_off']).optional(),
})

export const weeklyWasteSummarySchema = z.object({
	from: isoDateSchema,
	to: isoDateSchema,
	count: z.number().int(),
	valueMinor: minorOut,
	currency: currencyOut,
	topItems: z.array(
		z.object({
			itemId: z.string(),
			itemName: z.string(),
			count: z.number().int(),
			valueMinor: minorOut,
		}),
	),
	byReason: z.array(z.object({ reason: wasteReasonSchema, count: z.number().int() })),
})

export const morningBriefSummarySchema = z.object({
	date: isoDateSchema,
	deliveries: z.array(
		z.object({
			orderId: z.string(),
			supplierName: z.string(),
			expectedDate: isoDateSchema,
			overdue: z.boolean(),
		}),
	),
	counts: z.object({
		scheduled: z.array(
			z.object({
				countKind: z.enum(['full', 'quick']),
				slot: z.enum(['opening', 'close', 'custom']),
				dueAt: z.number().int(),
			}),
		),
		/** The weekly count day, with no schedule behind it. */
		weekly: z.boolean(),
		inProgress: z.boolean(),
	}),
	/** Prep tasks planned for today; null while prep is off. */
	prep: z.object({ tasks: z.number().int() }).nullable(),
	working: z.object({
		/** Shifts could be tied to this location. */
		known: z.boolean(),
		staff: z.array(z.object({ firstName: z.string() })),
	}),
	runningOut: z.array(
		z.object({
			itemId: z.string(),
			itemName: z.string(),
			status: z.enum(['low', 'out', 'runs_out_soon']),
		}),
	),
	/** With `inventory.use_by` on: stock past its date and stock to use first. */
	useBy: z.object({ expired: z.number().int(), useFirst: z.number().int() }).nullable(),
})

export const supplierCutoffSummarySchema = z.object({
	supplierId: z.string(),
	supplierName: z.string(),
	cutoffDate: isoDateSchema,
	cutoffTime: z.string(),
	itemCount: z.number().int(),
})

export const routineRunSchema = z.discriminatedUnion('key', [
	z.object({ key: z.literal('count_low_stock'), summary: countLowStockSummarySchema }),
	z.object({ key: z.literal('weekly_waste'), summary: weeklyWasteSummarySchema }),
	z.object({ key: z.literal('morning_brief'), summary: morningBriefSummarySchema }),
	z.object({ key: z.literal('supplier_cutoff'), summary: supplierCutoffSummarySchema }),
]).and(
	z.object({
		id: z.string(),
		locationId: z.string(),
		runKey: z.string(),
		status: z.enum(ROUTINE_RUN_STATUSES),
		/** The manager was told (or nothing needed telling). */
		alerted: z.boolean(),
		createdAt: z.number().int(),
	}),
)
export type RoutineRun = z.infer<typeof routineRunSchema>

export const routineSchema = z.object({
	key: routineKeySchema,
	enabled: z.boolean(),
	enabledAt: z.number().int().nullable(),
	version: z.number().int(),
	/** The template needs Purchasing, which is off: it cannot be turned on. */
	blocked: z.enum(['purchasing_off']).nullable(),
	/** The latest runs, newest first (up to five). */
	lastRuns: z.array(routineRunSchema),
})
export type Routine = z.infer<typeof routineSchema>

export const routinesQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const routinesSchema = z.object({
	locationId: z.string(),
	routines: z.array(routineSchema),
})

/** `PUT /routines/:key`: turn a routine on or off at a location. */
export const setRoutineSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		enabled: z.boolean(),
		/** 0 for a routine never turned on at the location. */
		expectedVersion: expectedVersionSchema,
	})
	.strict()

export const routineRunsQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		key: routineKeySchema.optional(),
	})
	.strict()

export const routineRunsSchema = z.object({
	runs: z.array(routineRunSchema),
	nextCursor: z.string().nullable(),
})

/** The alert a routine raises (ids and the key only; the summary stays in the region). */
export const routineAlertSchema = z
	.object({
		key: routineKeySchema,
		runId: z.string().min(1).max(64),
	})
	.strict()
export type RoutineAlert = z.infer<typeof routineAlertSchema>
