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
	/** Use-by dates on stock and prep labels (#479, #523). */
	useBy: 'inventory.use_by',
	/** Count stock by voice (#488). */
	voiceCounts: 'inventory.voice_counts',
	/** Supplier invoices by email and the invoices inbox (#503). */
	invoiceInbox: 'inventory.invoice_inbox',
	/** Ready-made back-of-house routines (#529). */
	routines: 'inventory.routines',
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
	/**
	 * The four flags below are additive: a context or token written before they
	 * existed has none, which reads as off.
	 */
	/** Use-by dates on stock, "Use first" and "Expired" on Today, prep labels. */
	useBy?: boolean
	/** The microphone on the count screens (still needs a speech model on the node). */
	voiceCounts?: boolean
	/** The invoice address and the "Invoices to match" inbox. */
	invoiceInbox?: boolean
	/** The Routines page. */
	routines?: boolean
}

export const INVENTORY_FEATURES_OFF: Readonly<InventoryFeatures> =
	Object.freeze({
		enabled: false,
		purchasing: false,
		recipes: false,
		prep: false,
		transfers: false,
		useBy: false,
		voiceCounts: false,
		invoiceInbox: false,
		routines: false,
	})

export const inventoryFeaturesSchema = z
	.object({
		enabled: z.boolean(),
		purchasing: z.boolean(),
		recipes: z.boolean(),
		prep: z.boolean(),
		transfers: z.boolean(),
		useBy: z.boolean().optional(),
		voiceCounts: z.boolean().optional(),
		invoiceInbox: z.boolean().optional(),
		routines: z.boolean().optional(),
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
		useBy: enabled && isInventoryFlagOn(raw.useBy),
		voiceCounts: enabled && isInventoryFlagOn(raw.voiceCounts),
		invoiceInbox: enabled && isInventoryFlagOn(raw.invoiceInbox),
		routines: enabled && isInventoryFlagOn(raw.routines),
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

const contextCurrencySchema = z
	.string()
	.regex(/^[A-Z]{3}$/)
	.nullable()
	.optional()
const contextTimeZoneSchema = z.string().min(1).max(64).nullable().optional()

/** The organization's own defaults, used while a location says nothing. */
export const inventoryContextOrganizationSchema = z.object({
	/** A hint only (the data region's usual currency); a location's own currency wins. */
	currency: contextCurrencySchema,
	timeZone: contextTimeZoneSchema,
})

export const inventoryContextLocationSchema = z.object({
	id: z.string().min(1).max(64),
	/** The location's currency when the control plane knows one; null/absent otherwise. */
	currency: contextCurrencySchema,
	timeZone: contextTimeZoneSchema,
	/** Menu prices include tax (VAT). */
	taxInclusive: z.boolean().optional(),
	/** Tax rate as a percentage (15 = 15%). */
	taxRatePercent: z.number().min(0).max(100).optional(),
	/** Special hours (closed dates skip repeat order runs, #499). */
	specialHours: z.unknown().nullable().optional(),
})
export type InventoryContextLocation = z.infer<
	typeof inventoryContextLocationSchema
>

/**
 * What the US App tells a region about an organization
 * (`GET /resources/inventory/context?orgId=`): its flags, nothing else.
 * Unknown fields are dropped so the App can add some before the regions read
 * them.
 */
export const inventoryContextSchema = z.object({
	orgId: z.string().min(1).max(64),
	features: inventoryFeaturesSchema,
	/**
	 * Additive (tenant migration 0039): what the control plane knows about the
	 * organization's money and days. The region keeps a copy
	 * (`inv_location_settings`); an older App sends none and the region keeps
	 * what it has.
	 */
	organization: inventoryContextOrganizationSchema.optional(),
	locations: z.array(inventoryContextLocationSchema).max(500).optional(),
})
export type InventoryContext = z.infer<typeof inventoryContextSchema>
