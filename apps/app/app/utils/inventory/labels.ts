import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	type AdjustmentReason,
	type InventoryCategory,
	type InventoryItemKind,
	type MovementKind,
	type WasteReason,
} from '@repo/inventory'

/**
 * Owner-language labels for the stored values. Built-in categories, reasons
 * and movement kinds are Lingui messages; an organization's own category is
 * stored as `custom:` plus the text it typed and shown as typed.
 */

export const CATEGORY_LABELS: Record<InventoryCategory, MessageDescriptor> = {
	meat: msg`Meat`,
	seafood: msg`Seafood`,
	produce: msg`Produce`,
	dairy: msg`Dairy`,
	dry_goods: msg`Dry goods`,
	bakery: msg`Bakery`,
	sauces: msg`Sauces`,
	drinks: msg`Drinks`,
	packaging: msg`Packaging`,
	cleaning: msg`Cleaning`,
	other: msg`Other`,
}

export const CUSTOM_CATEGORY_PREFIX = 'custom:'

export function customCategory(text: string): string {
	return `${CUSTOM_CATEGORY_PREFIX}${text.trim()}`
}

export function isBuiltInCategory(value: string): value is InventoryCategory {
	return Object.hasOwn(CATEGORY_LABELS, value)
}

export function categoryLabel(
	value: string | null | undefined,
	i18n: Pick<I18n, '_'>,
): string {
	if (!value) return ''
	if (isBuiltInCategory(value)) return i18n._(CATEGORY_LABELS[value])
	return value.startsWith(CUSTOM_CATEGORY_PREFIX)
		? value.slice(CUSTOM_CATEGORY_PREFIX.length)
		: value
}

export const WASTE_REASON_LABELS: Record<WasteReason, MessageDescriptor> = {
	expired: msg`Expired`,
	spoiled: msg`Spoiled`,
	over_prepped: msg`Over-prepped`,
	dropped: msg`Dropped`,
	returned: msg`Returned plate`,
	staff_meal: msg`Staff meal`,
	cancelled_after_cooking: msg`Cancelled after cooking`,
	remade_at_till: msg`Remade at the till`,
	other: msg`Other`,
}

export const ADJUSTMENT_REASON_LABELS: Record<
	AdjustmentReason,
	MessageDescriptor
> = {
	found: msg`Found more than expected`,
	damaged: msg`Damaged`,
	theft: msg`Missing or stolen`,
	correction: msg`Correction`,
	other: msg`Other`,
}

export const MOVEMENT_KIND_LABELS: Record<MovementKind, MessageDescriptor> = {
	delivery: msg`Delivered`,
	sale: msg`Used by sales`,
	waste: msg`Wasted`,
	count: msg`Counted`,
	adjustment: msg`Adjusted`,
	batch_made: msg`Made in house`,
	batch_used: msg`Used to make something`,
	transfer_in: msg`Moved in`,
	transfer_out: msg`Moved out`,
}

export const ITEM_KIND_LABELS: Record<InventoryItemKind, MessageDescriptor> = {
	bought: msg`Bought`,
	made: msg`Made in house`,
}
