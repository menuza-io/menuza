/**
 * Menuza menu file (#143). One JSON document of menus, categories, dishes,
 * modifier groups and options. No POS links, location overrides, discounts
 * or regional data. Images are URLs.
 */

import { dietaryTagsOf, parseMenuVariations } from '@repo/common/menu-types'
import { z } from 'zod'

export const MENU_FILE_VERSION = 1
export const MENU_FILE_MAX_BYTES = 5 * 1024 * 1024

const localized = z.string().max(20_000)
const id = z.string().min(1).max(64)

const menuRecord = z.object({
	id,
	displayName: localized,
	internalName: z.string().nullable().optional(),
	menuType: z.string().max(40),
	nutritionalInfo: z.boolean(),
	calorieDisplay: z.string().nullable().optional(),
	specialInstructions: z.boolean(),
	availabilityStatus: z.string().max(40),
	channels: z.string(),
	position: z.number().int(),
})

const categoryRecord = z.object({
	id,
	displayName: localized,
	internalName: z.string().nullable().optional(),
	description: localized.nullable().optional(),
	parentId: id.nullable().optional(),
	availabilityStatus: z.string().max(40),
	channels: z.string(),
	position: z.number().int(),
})

const itemRecord = z.object({
	id,
	displayName: localized,
	internalName: z.string().nullable().optional(),
	description: localized.nullable().optional(),
	price: z.number(),
	imageUrl: z.string().nullable().optional(),
	variations: z.string(),
	dietaryTags: z.array(z.string()),
	allergens: z.array(z.string()),
	calorieMin: z.number().int().nullable(),
	calorieMax: z.number().int().nullable(),
	barcode: z.string().nullable().optional(),
	availabilityStatus: z.string().max(40),
	channels: z.string(),
	position: z.number().int(),
	isAlcohol: z.boolean(),
	isPopular: z.boolean(),
	isUpsell: z.boolean(),
})

const groupRecord = z.object({
	id,
	name: localized,
	internalName: z.string().nullable().optional(),
	selectionType: z.string().max(40),
	minSelections: z.number().int(),
	maxSelections: z.number().int().nullable(),
	availabilityStatus: z.string().max(40),
	position: z.number().int(),
})

const optionRecord = z.object({
	id,
	displayName: localized,
	internalName: z.string().nullable().optional(),
	description: localized.nullable().optional(),
	price: z.number(),
	calories: z.number().int().nullable(),
	imageUrl: z.string().nullable().optional(),
	dietaryTags: z.array(z.string()),
	allergens: z.array(z.string()),
	barcode: z.string().nullable().optional(),
	availabilityStatus: z.string().max(40),
	position: z.number().int(),
})

const link = z.object({
	parentId: id,
	childId: id,
	position: z.number().int(),
})

export const menuFileSchema = z.object({
	version: z.literal(MENU_FILE_VERSION),
	exportedAt: z.string(),
	menus: z.array(menuRecord).max(200),
	categories: z.array(categoryRecord).max(2000),
	items: z.array(itemRecord).max(5000),
	modifierGroups: z.array(groupRecord).max(2000),
	options: z.array(optionRecord).max(8000),
	menuCategories: z.array(link).max(8000),
	categoryItems: z.array(link).max(20_000),
	itemGroups: z.array(link).max(20_000),
	groupOptions: z.array(link).max(40_000),
})

export type MenuFile = z.infer<typeof menuFileSchema>

export type MenuFileRecord = {
	menus: Array<{
		id: string
		displayName: string
		internalName: string | null
		menuType: string
		nutritionalInfo: boolean
		calorieDisplay: string | null
		specialInstructions: boolean
		availabilityStatus: string
		channels: string
		position: number
	}>
	categories: Array<{
		id: string
		displayName: string
		internalName: string | null
		description: string | null
		parentId: string | null
		availabilityStatus: string
		channels: string
		position: number
	}>
	items: Array<{
		id: string
		displayName: string
		internalName: string | null
		description: string | null
		price: number
		imageUrl: string | null
		variations: string
		dietaryTags: string
		allergens: string
		calorieMin: number | null
		calorieMax: number | null
		barcode: string | null
		availabilityStatus: string
		channels: string
		position: number
		isAlcohol: boolean
		isPopular: boolean
		isUpsell: boolean
	}>
	modifierGroups: Array<{
		id: string
		name: string
		internalName: string | null
		selectionType: string
		minSelections: number
		maxSelections: number | null
		availabilityStatus: string
		position: number
	}>
	options: Array<{
		id: string
		displayName: string
		internalName: string | null
		description: string | null
		price: number
		calories: number | null
		imageUrl: string | null
		dietaryTags: string
		allergens: string
		barcode: string | null
		availabilityStatus: string
		position: number
	}>
	menuCategories: Array<{
		menuId: string
		categoryId: string
		position: number
	}>
	categoryItems: Array<{ categoryId: string; itemId: string; position: number }>
	itemGroups: Array<{
		itemId: string
		modifierGroupId: string
		position: number
	}>
	groupOptions: Array<{
		modifierGroupId: string
		optionId: string
		position: number
	}>
}

function jsonArray(value: string | null | undefined): string[] {
	try {
		const parsed = JSON.parse(value || '[]') as unknown
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

/** Build a versioned file from the control-plane rows. Ids are the source ids. */
export function serializeMenuFile(
	records: MenuFileRecord,
	exportedAt: string,
): MenuFile {
	return {
		version: MENU_FILE_VERSION,
		exportedAt,
		menus: records.menus,
		categories: records.categories,
		items: records.items.map((item) => ({
			...item,
			dietaryTags: dietaryTagsOf({ dietaryTags: item.dietaryTags }),
			allergens: jsonArray(item.allergens),
			variations: JSON.stringify(parseMenuVariations(item.variations)),
		})),
		modifierGroups: records.modifierGroups,
		options: records.options.map((option) => ({
			...option,
			dietaryTags: dietaryTagsOf({ dietaryTags: option.dietaryTags }),
			allergens: jsonArray(option.allergens),
		})),
		menuCategories: records.menuCategories.map((row) => ({
			parentId: row.menuId,
			childId: row.categoryId,
			position: row.position,
		})),
		categoryItems: records.categoryItems.map((row) => ({
			parentId: row.categoryId,
			childId: row.itemId,
			position: row.position,
		})),
		itemGroups: records.itemGroups.map((row) => ({
			parentId: row.itemId,
			childId: row.modifierGroupId,
			position: row.position,
		})),
		groupOptions: records.groupOptions.map((row) => ({
			parentId: row.modifierGroupId,
			childId: row.optionId,
			position: row.position,
		})),
	}
}

export type ParseMenuFileResult =
	| { ok: true; file: MenuFile }
	| {
			ok: false
			error:
				'too_large' | 'invalid_json' | 'unsupported_version' | 'invalid_file'
			issues?: string[]
	  }

export function parseMenuFile(text: string): ParseMenuFileResult {
	if (Buffer.byteLength(text, 'utf8') > MENU_FILE_MAX_BYTES) {
		return { ok: false, error: 'too_large' }
	}
	let raw: unknown
	try {
		raw = JSON.parse(text) as unknown
	} catch {
		return { ok: false, error: 'invalid_json' }
	}
	if (
		raw &&
		typeof raw === 'object' &&
		'version' in raw &&
		(raw as { version: unknown }).version !== MENU_FILE_VERSION
	) {
		return { ok: false, error: 'unsupported_version' }
	}
	const parsed = menuFileSchema.safeParse(raw)
	if (!parsed.success) {
		return {
			ok: false,
			error: 'invalid_file',
			issues: parsed.error.issues
				.slice(0, 8)
				.map((issue) => issue.path.join('.')),
		}
	}
	const problems = validateMenuFile(parsed.data)
	if (problems.length > 0) {
		return { ok: false, error: 'invalid_file', issues: problems }
	}
	return { ok: true, file: parsed.data }
}

/** Reference checks the import runs before it writes. The #69 graph rules. */
export function validateMenuFile(file: MenuFile): string[] {
	const problems: string[] = []
	const menus = new Set(file.menus.map((row) => row.id))
	const categories = new Set(file.categories.map((row) => row.id))
	const items = new Set(file.items.map((row) => row.id))
	const groups = new Set(file.modifierGroups.map((row) => row.id))
	const options = new Set(file.options.map((row) => row.id))
	const unique = (label: string, ids: string[]) => {
		if (new Set(ids).size !== ids.length) problems.push(`duplicate_${label}`)
	}
	unique('menu', [...menus])
	unique('category', [...categories])
	unique('item', [...items])
	unique('group', [...groups])
	unique('option', [...options])
	for (const row of file.categories) {
		if (row.parentId && !categories.has(row.parentId)) {
			problems.push('category_parent')
		}
	}
	for (const row of file.menuCategories) {
		if (!menus.has(row.parentId) || !categories.has(row.childId)) {
			problems.push('menu_category')
		}
	}
	for (const row of file.categoryItems) {
		if (!categories.has(row.parentId) || !items.has(row.childId)) {
			problems.push('category_item')
		}
	}
	for (const row of file.itemGroups) {
		if (!items.has(row.parentId) || !groups.has(row.childId)) {
			problems.push('item_group')
		}
	}
	for (const row of file.groupOptions) {
		if (!groups.has(row.parentId) || !options.has(row.childId)) {
			problems.push('group_option')
		}
	}
	return [...new Set(problems)]
}

/** Content fingerprint that ignores ids, for a round trip into another org. */
export function menuFileContentKey(file: MenuFile): string {
	const names = (rows: Array<{ displayName?: string; name?: string }>) =>
		rows.map((row) => row.displayName ?? row.name ?? '').sort()
	return JSON.stringify({
		menus: names(file.menus),
		categories: names(file.categories),
		items: file.items
			.map((item) => `${item.displayName}|${item.price}|${item.barcode ?? ''}`)
			.sort(),
		groups: names(file.modifierGroups),
		options: file.options
			.map(
				(option) =>
					`${option.displayName}|${option.price}|${option.barcode ?? ''}`,
			)
			.sort(),
		links: [
			file.menuCategories.length,
			file.categoryItems.length,
			file.itemGroups.length,
			file.groupOptions.length,
		],
	})
}
