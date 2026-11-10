import { z } from 'zod'
import { inventoryLocationIdSchema } from './token.ts'
import { unitSystemSchema } from './units.ts'

/**
 * Wire contracts for `/operator/inventory/*`. Requests are strict (unknown
 * fields refused); responses are parsed leniently by clients so the region can
 * add fields before the App reads them.
 */

/** Local time of day, `HH:MM` (24 hours). */
export const inventoryTimeOfDaySchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time')

/**
 * One location's money and day, as the region keeps it. Read-only here: the
 * App (control plane) is the source of the time zone and tax, and the currency
 * is the App's or, without one, set by the location's first priced delivery.
 * `currency` is null while unknown (a quantity-only delivery then answers 409
 * `currency_unknown`). Never defaults to a currency.
 */
export const inventoryLocationSettingsSchema = z.object({
	locationId: z.string(),
	/** The ONE currency of this location's inventory money, or null while unknown. */
	currency: z.string().nullable(),
	/** `app`: told by the control plane; `delivery`: set by the first priced delivery. */
	currencySource: z.enum(['app', 'delivery']).nullable(),
	/** IANA time zone, or null while unknown (the business date then follows the organization's). */
	timeZone: z.string().nullable(),
	/** Minutes after local midnight when the business day starts (default 240). */
	dayStartMinutes: z.number().int().min(0).max(1439),
	/** Menu prices include tax (VAT): food cost percentages divide by the net price. */
	pricesIncludeTax: z.boolean(),
	/** Tax rate in basis points (1500 = 15%), or null when unknown. */
	taxRateBp: z.number().int().min(0).max(10_000).nullable(),
})
export type InventoryLocationSettings = z.infer<
	typeof inventoryLocationSettingsSchema
>

/** Organization-wide inventory settings. */
export const inventorySettingsSchema = z.object({
	/** Target food cost in basis points (3000 = 30%). */
	targetFoodCostBp: z.number().int().min(0).max(10_000),
	unitSystem: unitSystemSchema,
	/** Day of the weekly count (0 = Sunday … 6 = Saturday), or none. */
	countDayOfWeek: z.number().int().min(0).max(6).nullable(),
	/** Local time of the weekly count (`HH:MM`), or none (additive, 0039). */
	countTime: inventoryTimeOfDaySchema.nullable().optional(),
	/** Bumped on every change; send it back as `expectedVersion`. */
	version: z.number().int().min(0),
	updatedAt: z.number().int().nullable(),
	/**
	 * Phase 2: any signed-in Station staff member may receive deliveries (else
	 * a till manager, `pos_managers`). Default false; omitted by an older region.
	 */
	anyStaffCanReceive: z.boolean().optional(),
	/**
	 * `GET` only (additive, 0039): the money and day settings of every location
	 * the token covers. Read-only: the control plane is the source.
	 */
	locations: z.array(inventoryLocationSettingsSchema).optional(),
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
		countTime: inventoryTimeOfDaySchema.nullable().optional(),
		anyStaffCanReceive: z.boolean().optional(),
	})
	.strict()
	.refine(
		(body) =>
			body.targetFoodCostBp !== undefined ||
			body.unitSystem !== undefined ||
			body.countDayOfWeek !== undefined ||
			body.countTime !== undefined ||
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
