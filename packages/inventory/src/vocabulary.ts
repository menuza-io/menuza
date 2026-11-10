import { z } from 'zod'

/**
 * Built-in categories. Labels live in the apps (Lingui); an organization can
 * also type its own category, stored as plain text.
 */
export const INVENTORY_CATEGORIES = [
	'meat',
	'seafood',
	'produce',
	'dairy',
	'dry_goods',
	'bakery',
	'sauces',
	'drinks',
	'packaging',
	'cleaning',
	'other',
] as const
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number]

/** A stored category: a built-in key, or `custom:` followed by typed text. */
export const inventoryCategorySchema = z.union([
	z.enum(INVENTORY_CATEGORIES),
	z
		.string()
		.trim()
		.regex(/^custom:.{1,40}$/su, 'Invalid category'),
])

/** Bought from a supplier, or made in house from other items. */
export const INVENTORY_ITEM_KINDS = ['bought', 'made'] as const
export type InventoryItemKind = (typeof INVENTORY_ITEM_KINDS)[number]
export const inventoryItemKindSchema = z.enum(INVENTORY_ITEM_KINDS)

export const WASTE_REASONS = [
	'expired',
	'spoiled',
	'over_prepped',
	'dropped',
	'returned',
	'staff_meal',
	'cancelled_after_cooking',
	'remade_at_till',
	'other',
] as const
export type WasteReason = (typeof WASTE_REASONS)[number]
export const wasteReasonSchema = z.enum(WASTE_REASONS)

/** Reasons a person picks; the last two are recorded by the system. */
export const PICKABLE_WASTE_REASONS = WASTE_REASONS.filter(
	(reason) =>
		reason !== 'cancelled_after_cooking' && reason !== 'remade_at_till',
)

/**
 * Why on-hand stock changed. Every movement has one kind; on hand at a
 * location is the sum of its movements.
 */
export const MOVEMENT_KINDS = [
	'delivery',
	'sale',
	'waste',
	'count',
	'adjustment',
	'batch_made',
	'batch_used',
	'transfer_in',
	'transfer_out',
] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]
export const movementKindSchema = z.enum(MOVEMENT_KINDS)

/** Reasons a manager gives for adjusting stock by hand. */
export const ADJUSTMENT_REASONS = [
	'found',
	'damaged',
	'theft',
	'correction',
	'other',
] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]
export const adjustmentReasonSchema = z.enum(ADJUSTMENT_REASONS)

export const COUNT_STATUSES = [
	'counting',
	'in_review',
	'approved',
	'cancelled',
] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]

/**
 * Inventory is per location. An organization without locations uses this
 * implicit one, the same fallback as staffing's `DEFAULT_SCOPE_ID`.
 */
export const DEFAULT_INVENTORY_LOCATION_ID = 'main'
