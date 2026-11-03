import { z } from 'zod'

/** Most menu items, or categories, one earning rule or reward can name. */
export const LOYALTY_MAX_ITEM_IDS = 200
export const LOYALTY_MAX_CATEGORY_IDS = 100

/** Catalog ids (menu items, categories) as the order engines send them. */
export const loyaltyCatalogIdSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_:.-]+$/, 'Invalid catalog id')

const catalogLabelRecord = (max: number) =>
	z
		.record(loyaltyCatalogIdSchema, z.string().trim().min(1).max(120))
		.refine((labels) => Object.keys(labels).length <= max, 'Too many labels')
		.default({})

/**
 * Display names captured from the catalog when the operator saved: at most one
 * per id the rule or reward names, so the maps stay within the id list bounds.
 * Which ids they may name is checked where the ids are known
 * (`refineCatalogLabels`).
 */
export const loyaltyCatalogLabelsSchema = z
	.object({
		items: catalogLabelRecord(LOYALTY_MAX_ITEM_IDS),
		categories: catalogLabelRecord(LOYALTY_MAX_CATEGORY_IDS),
	})
	.strict()
export type LoyaltyCatalogLabels = z.infer<typeof loyaltyCatalogLabelsSchema>

/**
 * Every label must belong to an id the rule or reward actually references.
 * Messages never repeat a key from the payload.
 */
export function refineCatalogLabels(
	labels: LoyaltyCatalogLabels,
	referenced: { itemIds: readonly string[]; categoryIds: readonly string[] },
	ctx: z.RefinementCtx,
	path: Array<string | number> = ['labels'],
): void {
	const itemIds = new Set(referenced.itemIds)
	const categoryIds = new Set(referenced.categoryIds)
	if (Object.keys(labels.items).some((id) => !itemIds.has(id))) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [...path, 'items'],
			message: 'A label names an item that is not chosen',
		})
	}
	if (Object.keys(labels.categories).some((id) => !categoryIds.has(id))) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: [...path, 'categories'],
			message: 'A label names a category that is not chosen',
		})
	}
}
