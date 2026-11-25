import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	currencyOut,
	inventoryIdSchema,
	isoDateSchema,
	minorOut,
	unitRefSchema,
} from './common.ts'
import { itemUnitSchema } from './items.ts'

/**
 * Expected versus actual use by item between two approved full counts (#509),
 * per location, behind `inventory.recipes` (expected use comes from sales and
 * batches through recipes). It reads the existing ledger: nothing here is
 * stored.
 *
 * A period runs from one approved FULL count to the next (the same instants
 * food cost uses, `computeFoodCost`), so the totals tie out:
 *
 *     actual use   = opening + purchases - closing
 *     expected use = what sales and batches used, from the recipes in force
 *     gap          = actual - expected
 *                  = waste + adjustments + what the closing count found missing
 *
 * where `purchases` is deliveries and transfers in, less transfers out, and a
 * made item's batches are use of its ingredients and supply of itself. In
 * money the totals are exactly the period's actual food cost minus its
 * expected food cost. An item no recipe uses shows actual use only
 * (`noRecipe`): its gap is not shown, so it cannot mislead; its actual use is
 * still in the totals (`noRecipeUseMinor`). Money needs the cost grant.
 */

export const VARIANCE_TREND_PERIODS = 6

export const varianceQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		/** The count that closes the period; default: the latest approved full count. */
		closingCountId: inventoryIdSchema.optional(),
	})
	.strict()

export const varianceMovementsQuerySchema = varianceQuerySchema
	.extend({ itemId: inventoryIdSchema })
	.strict()

export const variancePeriodSchema = z.object({
	openingCountId: z.string(),
	closingCountId: z.string(),
	/** Business dates of the two counts' instants. */
	from: isoDateSchema,
	to: isoDateSchema,
	openingAt: z.number().int(),
	closingAt: z.number().int(),
})
export type VariancePeriod = z.infer<typeof variancePeriodSchema>

export const varianceTrendPointSchema = z.object({
	closingCountId: z.string(),
	to: isoDateSchema,
	/** Quantity gap in base thousandths (null: no recipe). */
	gapQuantity: z.number().int().nullable(),
	gapMinor: minorOut,
})

export const varianceRowSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema,
	units: z.array(itemUnitSchema),
	/** Base thousandths. */
	opening: z.number().int(),
	delivered: z.number().int(),
	/** Transfers in less transfers out (negative: more left than arrived). */
	transfers: z.number().int(),
	/** Batches made (supplied). */
	batchMade: z.number().int(),
	/** Logged waste, as corrected. */
	waste: z.number().int(),
	closing: z.number().int(),
	actualUse: z.number().int(),
	/** Null with `noRecipe`. */
	expectedUse: z.number().int().nullable(),
	gapQuantity: z.number().int().nullable(),
	noRecipe: z.boolean(),
	/** Money (cost grant). */
	actualUseMinor: minorOut,
	expectedUseMinor: minorOut,
	gapMinor: minorOut,
	/** The gap as a share of the period's net sales, in basis points (null: no sales). */
	gapBpOfSales: z.number().int().nullable().optional(),
	/** The last periods, oldest first, this one last. */
	trend: z.array(varianceTrendPointSchema),
})
export type VarianceRow = z.infer<typeof varianceRowSchema>

export const varianceTotalsSchema = z.object({
	/** Opening + purchases - closing, over every item (equals food cost's figure). */
	actualMinor: z.number().int(),
	/** What recipes say sales and batches used, over every item. */
	expectedMinor: z.number().int(),
	/** actual - expected. */
	gapMinor: z.number().int(),
	gapBpOfSales: z.number().int().nullable(),
	/** Of the actual use, what belongs to items no recipe uses (their gap is not shown). */
	noRecipeUseMinor: z.number().int(),
	wasteMinor: z.number().int(),
})

export const varianceSchema = z.object({
	state: z.enum(['ok', 'need_two_counts']),
	period: variancePeriodSchema.nullable(),
	/** Periods that can be chosen, newest first (up to the trend length). */
	periods: z.array(
		z.object({
			closingCountId: z.string(),
			from: isoDateSchema,
			to: isoDateSchema,
		}),
	),
	rows: z.array(varianceRowSchema),
	/** Net sales of the period (cost grant). */
	salesMinor: minorOut,
	totals: varianceTotalsSchema.optional(),
	currency: currencyOut,
})
export type Variance = z.infer<typeof varianceSchema>

/** One movement behind a row. Quantities are base thousandths; money is cost grant. */
export const varianceMovementSchema = z.object({
	id: z.string(),
	kind: z.string(),
	quantity: z.number().int(),
	valueMinor: minorOut,
	currency: currencyOut,
	reason: z.string().nullable(),
	sourceType: z.string(),
	businessDate: isoDateSchema,
	createdAt: z.number().int(),
})

export const varianceMovementsSchema = z.object({
	itemId: z.string(),
	movements: z.array(varianceMovementSchema),
	/** More than the page: the list stops at this many, newest first. */
	truncated: z.boolean(),
})
export type VarianceMovements = z.infer<typeof varianceMovementsSchema>
