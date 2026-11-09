import { z } from 'zod'

/**
 * ConfigFlag keys for Inventory. Every flag defaults to off and is turned on
 * per organization. Only a literal boolean `true` counts as on.
 * `inventory.enabled` is the master flag: the child flags read as off whenever
 * it is not on.
 */
export const INVENTORY_FLAG_KEYS = {
	enabled: 'inventory.enabled',
	purchasing: 'inventory.purchasing',
	recipes: 'inventory.recipes',
	prep: 'inventory.prep',
	transfers: 'inventory.transfers',
} as const

export type InventoryFlagName = keyof typeof INVENTORY_FLAG_KEYS
export type InventoryFlagKey = (typeof INVENTORY_FLAG_KEYS)[InventoryFlagName]

export const INVENTORY_FLAG_KEY_LIST: readonly InventoryFlagKey[] =
	Object.values(INVENTORY_FLAG_KEYS)

export type InventoryFeatures = {
	/** Today, Stock, Counts, Waste, deliveries and suppliers. */
	enabled: boolean
	/** Levels, suggested orders, sending orders, unpaid deliveries. */
	purchasing: boolean
	/** Dish costs, stock used by sales, expected vs counted, auto sold out. */
	recipes: boolean
	/** Prep list and board. */
	prep: boolean
	/** Transfers between locations and the central kitchen. */
	transfers: boolean
}

export const INVENTORY_FEATURES_OFF: Readonly<InventoryFeatures> =
	Object.freeze({
		enabled: false,
		purchasing: false,
		recipes: false,
		prep: false,
		transfers: false,
	})

export const inventoryFeaturesSchema = z
	.object({
		enabled: z.boolean(),
		purchasing: z.boolean(),
		recipes: z.boolean(),
		prep: z.boolean(),
		transfers: z.boolean(),
	})
	.strict()

export function isInventoryFlagOn(value: unknown): boolean {
	return value === true
}

/**
 * Fold raw flag values, keyed by short name, into features. Children are
 * forced off whenever the master flag is not on.
 */
export function foldInventoryFeatures(
	raw: Partial<Record<InventoryFlagName, unknown>>,
): InventoryFeatures {
	const enabled = isInventoryFlagOn(raw.enabled)
	return {
		enabled,
		purchasing: enabled && isInventoryFlagOn(raw.purchasing),
		recipes: enabled && isInventoryFlagOn(raw.recipes),
		prep: enabled && isInventoryFlagOn(raw.prep),
		transfers: enabled && isInventoryFlagOn(raw.transfers),
	}
}

/**
 * Read features from an untrusted payload such as a context response or a
 * token claim. Anything missing or malformed reads as all off.
 */
export function readInventoryFeatures(raw: unknown): InventoryFeatures {
	const parsed = inventoryFeaturesSchema.safeParse(raw)
	if (!parsed.success) return { ...INVENTORY_FEATURES_OFF }
	return foldInventoryFeatures(parsed.data)
}

/**
 * What the US App tells a region about an organization
 * (`GET /resources/inventory/context?orgId=`): its flags, nothing else.
 * Unknown fields are dropped so the App can add some before the regions read
 * them.
 */
export const inventoryContextSchema = z.object({
	orgId: z.string().min(1).max(64),
	features: inventoryFeaturesSchema,
})
export type InventoryContext = z.infer<typeof inventoryContextSchema>
