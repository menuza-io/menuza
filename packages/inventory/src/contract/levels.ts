import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryBaseUnitSchema } from '../units.ts'
import {
	clientIdSchema,
	expectedVersionSchema,
	inventoryIdSchema,
	listQuerySchema,
	nonNegativeQuantitySchema,
	unitRefSchema,
} from './common.ts'
import { itemUnitSchema, stockStatusSchema } from './items.ts'
import { levelsOrdered } from './orders-rules.ts'

/**
 * Phase 2, levels: "Order more when below" and "Fill up to" per item per
 * location, for the Levels sheet (every item in one table) as well as the
 * item sheet (`PUT /items/:id/places/:locationId`, phase 1, unchanged).
 * Behind the `inventory.purchasing` flag. Reads need `read:inventory:any`;
 * `PUT /levels/bulk` needs `update:inventory_purchasing:any` (levels drive
 * ordering; the item sheet's `places` route keeps `update:inventory:any`
 * because it also sets count units and areas). No money anywhere.
 */

/**
 * `GET /levels?locationId=&q=&category=&supplierId=&filter=&limit=&cursor=`
 * (read; by name). `filter`: `all`, `unset` (no level yet) or `set`.
 */
export const listLevelsQuerySchema = listQuerySchema
	.extend({
		locationId: inventoryLocationIdSchema,
		q: z.string().trim().max(80).optional(),
		category: z.string().max(60).optional(),
		supplierId: inventoryIdSchema.optional(),
		filter: z.enum(['all', 'unset', 'set']).default('all'),
	})
	.strict()

export const levelRowSchema = z.object({
	itemId: z.string(),
	name: z.string(),
	category: z.string(),
	baseUnit: inventoryBaseUnitSchema,
	countUnit: unitRefSchema.nullable(),
	units: z.array(itemUnitSchema),
	onHand: z.number().int(),
	orderBelowQuantity: z.number().int().nullable(),
	fillUpToQuantity: z.number().int().nullable(),
	/** The item's place row version at this location; 0 = no place row yet (send 0 to create it). */
	placeVersion: z.number().int(),
	status: stockStatusSchema,
	/** The preferred supplier (else the only one), to group the sheet and to explain a suggestion. */
	supplierId: z.string().nullable(),
	supplierName: z.string().nullable(),
	packName: z.string().nullable(),
	packBaseQuantity: z.number().int().nullable(),
})
export type LevelRow = z.infer<typeof levelRowSchema>

export const listLevelsResultSchema = z.object({
	levels: z.array(levelRowSchema),
	total: z.number().int(),
	nextCursor: z.string().nullable(),
})

/**
 * `PUT /levels/bulk` (`update:inventory_purchasing:any`): set levels for up
 * to 200 items at one location. Rows are independent: each carries the place
 * `expectedVersion` the sheet read (`placeVersion`; 0 creates the place row
 * with the item's default count unit), and a row that cannot be applied is
 * reported in `refused` (`stale_version`, `not_found` for an archived or
 * unknown item) while the others are saved. A level must satisfy
 * `orderBelowQuantity <= fillUpToQuantity` when both are set (400
 * `invalid_request` for the request otherwise). A replayed `clientId` answers
 * the first result.
 */
export const putLevelsSchema = z
	.object({
		clientId: clientIdSchema,
		locationId: inventoryLocationIdSchema,
		levels: z
			.array(
				z
					.object({
						itemId: inventoryIdSchema,
						orderBelowQuantity: nonNegativeQuantitySchema.nullable(),
						fillUpToQuantity: nonNegativeQuantitySchema.nullable(),
						expectedVersion: expectedVersionSchema,
					})
					.strict()
					.refine(
						(row) =>
							levelsOrdered(row.orderBelowQuantity, row.fillUpToQuantity),
						{
							path: ['orderBelowQuantity'],
							message: 'Order more when below must not exceed fill up to',
						},
					),
			)
			.min(1)
			.max(200),
	})
	.strict()
export type PutLevels = z.infer<typeof putLevelsSchema>

export const putLevelsResultSchema = z.object({
	updated: z.array(
		z.object({
			itemId: z.string(),
			version: z.number().int(),
			orderBelowQuantity: z.number().int().nullable(),
			fillUpToQuantity: z.number().int().nullable(),
		}),
	),
	refused: z.array(z.object({ itemId: z.string(), code: z.string() })),
})

/**
 * `GET /levels/suggestions?locationId=&days=&coverDays=&orderBelowDays=`
 * (read): "you use about 22 kg a week". For each item used in the window the
 * region sums what left stock (sales, waste, counted shortfalls; never
 * deliveries or transfers) over `days` (default 28, at most 90) and applies
 * `suggestLevelsFromUse`. `daysObserved` is the days since the location's
 * first movement, capped at `days`: the App says "not enough history yet"
 * under 14. Suggestions are never applied by themselves; the App fills the
 * sheet's fields and the person saves with `PUT /levels/bulk`.
 */
export const levelSuggestionsQuerySchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		days: z.coerce.number().int().min(7).max(90).default(28),
		coverDays: z.coerce.number().int().min(1).max(60).default(7),
		orderBelowDays: z.coerce.number().int().min(1).max(30).default(3),
	})
	.strict()

export const levelSuggestionsSchema = z.object({
	locationId: z.string(),
	days: z.number().int(),
	daysObserved: z.number().int(),
	suggestions: z.array(
		z.object({
			itemId: z.string(),
			/** Used over `daysObserved`, base thousandths. */
			usedQuantity: z.number().int(),
			weeklyUseQuantity: z.number().int(),
			orderBelowQuantity: z.number().int(),
			fillUpToQuantity: z.number().int(),
		}),
	),
})
export type LevelSuggestions = z.infer<typeof levelSuggestionsSchema>
