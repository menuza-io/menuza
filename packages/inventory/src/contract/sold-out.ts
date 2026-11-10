import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import { inventoryIdSchema } from './common.ts'

/**
 * Auto sold out (phase 3). An item can be set to "Mark dishes sold out when
 * this runs out". When its stock at a location reaches zero AND it was counted
 * in the last 7 days (a drifting estimate must never take dishes off the
 * menu), the region takes every dish and option that needs it off the menu at
 * that location, and gives them back when stock comes back. Two contracts:
 *
 * - Region to App, `POST /resources/inventory/availability` (internal token):
 *   ids only, the App writes the menu availability. It never carries a name or
 *   an amount, and it can only turn a dish unavailable or put back one the
 *   region took off.
 * - Operators, `GET /sold-out` and `POST /sold-out/:id/undo`
 *   (`read` / `update:inventory:any`): what was sold out by stock and the
 *   manager's undo.
 */

/** Sold out only counts if the item was counted this recently. */
export const AUTO_SOLD_OUT_MAX_COUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const INVENTORY_AVAILABILITY_PATH = '/resources/inventory/availability'

export const SOLD_OUT_ENTITY_TYPES = ['item', 'modifier_option'] as const
export const soldOutEntityTypeSchema = z.enum(SOLD_OUT_ENTITY_TYPES)
export type SoldOutEntityType = z.infer<typeof soldOutEntityTypeSchema>

export const MAX_AVAILABILITY_CHANGES = 100

export const availabilityChangeSchema = z
	.object({
		entityType: soldOutEntityTypeSchema,
		entityId: z.string().min(1).max(100),
		/** `false` takes it off the menu; `true` gives back what the region took off. */
		available: z.boolean(),
		/**
		 * When `available` is true: the moment the region took it off. The App
		 * puts it back only if nobody changed it by hand since, so a manual
		 * "unavailable" is never overruled.
		 */
		since: z.number().int().nonnegative().optional(),
	})
	.strict()
export type AvailabilityChange = z.infer<typeof availabilityChangeSchema>

export const inventoryAvailabilityRequestSchema = z
	.object({
		orgId: z.string().min(1).max(64),
		locationId: inventoryLocationIdSchema,
		changes: z
			.array(availabilityChangeSchema)
			.min(1)
			.max(MAX_AVAILABILITY_CHANGES),
	})
	.strict()
export type InventoryAvailabilityRequest = z.infer<
	typeof inventoryAvailabilityRequestSchema
>

/**
 * The App's answer, counts only. 200 also when nothing was applied
 * (`skipped`: flag off, unknown location), so the region stops retrying what
 * cannot succeed. `applied` lists the entity ids it changed; the region only
 * records what the App confirmed.
 */
export const inventoryAvailabilityResultSchema = z
	.object({
		applied: z.array(z.string().max(100)).max(MAX_AVAILABILITY_CHANGES),
		skipped: z.string().max(64).optional(),
	})
	.strict()
export type InventoryAvailabilityResult = z.infer<
	typeof inventoryAvailabilityResultSchema
>

export const SOLD_OUT_STATES = ['out', 'undone'] as const

/** One dish or option taken off the menu by stock. Names are joined by the App from the menu. */
export const soldOutEntrySchema = z.object({
	id: z.string(),
	locationId: z.string(),
	entityType: soldOutEntityTypeSchema,
	entityId: z.string(),
	causeItemId: z.string(),
	causeItemName: z.string(),
	state: z.enum(SOLD_OUT_STATES),
	soldAt: z.number().int(),
})
export type SoldOutEntry = z.infer<typeof soldOutEntrySchema>

/** `GET /sold-out?locationId=`: the entries standing now (`out` and `undone`). */
export const soldOutListSchema = z.object({
	locationId: z.string(),
	entries: z.array(soldOutEntrySchema),
})
export type SoldOutList = z.infer<typeof soldOutListSchema>

/** `POST /sold-out/:id/undo` (`update:inventory:any`): put the dish back although the stock is still at zero. */
export const undoSoldOutSchema = z.object({}).strict()

export const soldOutIdSchema = inventoryIdSchema
