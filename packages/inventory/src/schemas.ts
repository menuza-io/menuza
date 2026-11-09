import { z } from 'zod'
import { inventoryLocationIdSchema } from './token.ts'
import { unitSystemSchema } from './units.ts'

/**
 * Wire contracts for `/operator/inventory/*`. Requests are strict (unknown
 * fields refused); responses are parsed leniently by clients so the region can
 * add fields before the App reads them.
 */

/** Organization-wide inventory settings. */
export const inventorySettingsSchema = z.object({
	/** Target food cost in basis points (3000 = 30%). */
	targetFoodCostBp: z.number().int().min(0).max(10_000),
	unitSystem: unitSystemSchema,
	/** Day of the weekly count (0 = Sunday … 6 = Saturday), or none. */
	countDayOfWeek: z.number().int().min(0).max(6).nullable(),
	/** Bumped on every change; send it back as `expectedVersion`. */
	version: z.number().int().min(0),
	updatedAt: z.number().int().nullable(),
	/**
	 * Phase 2: any signed-in Station staff member may receive deliveries (else
	 * a till manager, `pos_managers`). Default false; omitted by an older region.
	 */
	anyStaffCanReceive: z.boolean().optional(),
})
export type InventorySettings = z.infer<typeof inventorySettingsSchema>

export const DEFAULT_TARGET_FOOD_COST_BP = 3000

/** `PUT /operator/inventory/settings` (needs `update:inventory:any`). */
export const updateInventorySettingsSchema = z
	.object({
		expectedVersion: z.number().int().min(0),
		targetFoodCostBp: z.number().int().min(0).max(10_000).optional(),
		unitSystem: unitSystemSchema.optional(),
		countDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
		anyStaffCanReceive: z.boolean().optional(),
	})
	.strict()
	.refine(
		(body) =>
			body.targetFoodCostBp !== undefined ||
			body.unitSystem !== undefined ||
			body.countDayOfWeek !== undefined ||
			body.anyStaffCanReceive !== undefined,
		{ message: 'Nothing to change' },
	)
export type UpdateInventorySettings = z.infer<
	typeof updateInventorySettingsSchema
>

/** `GET /operator/inventory/status?locationId=`: setup checklist facts. */
export const inventoryStatusQuerySchema = z
	.object({ locationId: inventoryLocationIdSchema })
	.strict()

export const inventoryStatusSchema = z.object({
	locationId: inventoryLocationIdSchema,
	/** Active items in the organization's catalogue. */
	items: z.number().int().min(0),
	/** Storage areas at this location. */
	storageAreas: z.number().int().min(0),
	/** Approved counts at this location. */
	approvedCounts: z.number().int().min(0),
	/** Deliveries recorded at this location. */
	deliveries: z.number().int().min(0),
})
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>
