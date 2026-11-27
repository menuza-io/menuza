import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	currencyOut,
	inventoryIdSchema,
	isoDateSchema,
	unitRefSchema,
} from './common.ts'

/**
 * Stock and stock value on any past business day (#521). A read model over the
 * append-only ledger (`inv_movements`): nothing is stored, so it can never
 * disagree with the ledger.
 *
 * - A business day is the location's own (its time zone and day start): a
 *   movement belongs to the `business_date` it was written with.
 * - On hand at the end of a day is the sum of every movement up to and
 *   including it; opening is the same sum to the day before.
 * - Value is the sum of the movements' own values. A movement written without a
 *   value (a quantity-only delivery) is valued at the item's average cost on its
 *   day, from the cost history; when none was known yet, the first one known
 *   after it (the delivery priced later). An item that never had a cost adds
 *   nothing and is counted in `unpricedItems`.
 * - Money needs `read:inventory_cost:any`; without it every `money` /
 *   `valueMinor` field is absent and the quantities stay.
 */

export const stockOnDateQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		/** The business day (today when absent). A day in the future answers 400 `date_in_future`. */
		date: isoDateSchema.optional(),
		q: z.string().trim().max(80).optional(),
		/** Items that have no stock on that day are left out unless asked for. */
		includeZero: z.stringbool().default(false),
	})
	.strict()

export const stockOnDateItemSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	category: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	/** On hand at the end of the day, base thousandths (may be negative). */
	onHand: z.number().int(),
	/** Cost grant only. Null when no cost was known by then. */
	valueMinor: z.number().int().nullable().optional(),
})
export type StockOnDateItem = z.infer<typeof stockOnDateItemSchema>

export const stockOnDateSchema = z.object({
	locationId: z.string(),
	date: isoDateSchema,
	/** The location's business day right now. */
	today: isoDateSchema,
	/** The day is still open: figures are "so far". */
	open: z.boolean(),
	items: z.array(stockOnDateItemSchema),
	/** Cost grant only. */
	totalValueMinor: z.number().int().optional(),
	currency: currencyOut,
	/** Items on hand with no cost known on that day (cost grant only). */
	unpricedItems: z.number().int().optional(),
})
export type StockOnDate = z.infer<typeof stockOnDateSchema>

export const stockDayQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		date: isoDateSchema,
		itemId: inventoryIdSchema.optional(),
	})
	.strict()

/** The quantities of one item on one day. `opening + movements = closing`, exactly. */
export const STOCK_DAY_COLUMNS = [
	'opening',
	'delivered',
	'used',
	'wasted',
	'transfersIn',
	'transfersOut',
	'adjustments',
	'countCorrections',
	'made',
	'prepUsed',
	'closing',
] as const
export type StockDayColumn = (typeof STOCK_DAY_COLUMNS)[number]

const columnsOf = <T extends z.ZodTypeAny>(shape: T) =>
	z.object(Object.fromEntries(STOCK_DAY_COLUMNS.map((c) => [c, shape])))

export const stockDayRowSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	category: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	/** Base thousandths. `used` is by sales, `prepUsed` is ingredients taken for batches. */
	quantity: columnsOf(z.number().int()),
	/** Cost grant only: the same columns in minor units. */
	money: columnsOf(z.number().int()).optional(),
})
export type StockDayRow = z.infer<typeof stockDayRowSchema>

export const stockDaySchema = z.object({
	locationId: z.string(),
	date: isoDateSchema,
	today: isoDateSchema,
	open: z.boolean(),
	rows: z.array(stockDayRowSchema),
	/** Cost grant only: the columns summed over every row. */
	totalsMoney: columnsOf(z.number().int()).optional(),
	currency: currencyOut,
	unpricedItems: z.number().int().optional(),
})
export type StockDay = z.infer<typeof stockDaySchema>

/** `GET /stock/value-export?locationId=&date=&cursor=`: one page of the month-end file (cost grant). */
export const stockValueExportQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		date: isoDateSchema,
		cursor: z.string().regex(/^\d{1,7}$/).optional(),
	})
	.strict()

export const exportChunkSchema = z.object({
	header: z.array(z.string()).optional(),
	rows: z.array(z.array(z.string())),
	nextCursor: z.string().nullable(),
	total: z.number().int(),
	matching: z.number().int(),
	truncated: z.boolean(),
	footer: z.array(z.array(z.string())).nullable().optional(),
})
