import { z } from 'zod'

export const ALLERGENS = [
	'dairy',
	'eggs',
	'fish',
	'gluten',
	'mango',
	'peanuts',
	'sesame',
	'shellfish',
	'soy',
	'tree_nuts',
] as const

export type Allergen = (typeof ALLERGENS)[number]

export const ALLERGEN_LABELS: Record<Allergen, string> = {
	dairy: 'Dairy',
	eggs: 'Eggs',
	fish: 'Fish',
	gluten: 'Gluten',
	mango: 'Mango',
	peanuts: 'Peanuts',
	sesame: 'Sesame',
	shellfish: 'Shellfish',
	soy: 'Soy',
	tree_nuts: 'Tree Nuts',
}

export const DIETARY_FLAGS = ['alcohol', 'gluten_free', 'vegetarian'] as const
export type DietaryFlag = (typeof DIETARY_FLAGS)[number]

export const DIETARY_FLAG_LABELS: Record<DietaryFlag, string> = {
	alcohol: 'Alcohol',
	gluten_free: 'Gluten-Free',
	vegetarian: 'Vegetarian',
}

export const AVAILABILITY_STATUSES = [
	'available',
	'unavailable_until',
	'unavailable_until_tomorrow',
	'unavailable',
] as const

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number]

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
	available: 'Available',
	unavailable_until: 'Unavailable until',
	unavailable_until_tomorrow: 'Unavailable until tomorrow',
	unavailable: 'Unavailable',
}

export const MENU_TYPES = ['online_pos_kiosk', 'catering'] as const
export type MenuType = (typeof MENU_TYPES)[number]

export const MENU_TYPE_LABELS: Record<MenuType, string> = {
	online_pos_kiosk: 'Online Ordering / POS / Kiosk',
	catering: 'Catering',
}

export const MODIFIER_SELECTION_TYPES = [
	'single',
	'multiple',
	'quantity',
	'pizza',
] as const

export type ModifierSelectionType = (typeof MODIFIER_SELECTION_TYPES)[number]

export const MODIFIER_SELECTION_LABELS: Record<ModifierSelectionType, string> =
	{
		single: 'Single selection',
		multiple: 'Multiple selection',
		quantity: 'Quantity selection',
		pizza: 'Pizza selection (whole / half)',
	}

// Helper to safely extract localized name from JSON or plain string
export function getLocalizedMenuValue(
	val: string | null | undefined,
	locale: string = 'en',
	defaultLocale: string = 'en',
): string {
	if (!val) return ''
	if (typeof val === 'string' && val.startsWith('{')) {
		try {
			const obj = JSON.parse(val) as Record<string, string>
			return obj[locale] || obj[defaultLocale] || Object.values(obj)[0] || ''
		} catch {
			return val
		}
	}
	return val
}

// Schemas
export const AllergenSchema = z.enum(ALLERGENS)
export const DietaryFlagSchema = z.enum(DIETARY_FLAGS)
export const AvailabilityStatusSchema = z.enum(AVAILABILITY_STATUSES)
export const MenuTypeSchema = z.enum(MENU_TYPES)
export const ModifierSelectionTypeSchema = z.enum(MODIFIER_SELECTION_TYPES)

export const MenuVariationGroupSchema = z.object({
	id: z.string().min(1),
	name: z.string().trim().min(1, 'Variation name is required').max(80),
	values: z
		.array(
			z.object({
				id: z.string().min(1),
				name: z.string().trim().min(1, 'Option name is required').max(80),
			}),
		)
		.min(1, 'Add at least one option')
		.max(100),
})

export const MenuVariationSchema = z
	.object({
		id: z.string().min(1),
		valueIds: z.array(z.string()).min(1).max(3),
		price: z.number().finite().min(0, 'Variation price must be positive'),
		imageKey: z.string().nullable().default(null),
		availabilityStatus: z
			.enum(['available', 'unavailable_until', 'unavailable'])
			.default('available'),
		unavailableUntil: z
			.string()
			.refine(
				(value) => !Number.isNaN(Date.parse(value)),
				'Invalid return time',
			)
			.nullable()
			.default(null),
	})
	.refine(
		(variant) =>
			variant.availabilityStatus !== 'unavailable_until' ||
			variant.unavailableUntil !== null,
		{ path: ['unavailableUntil'], message: 'Choose when it becomes available' },
	)

export const MenuVariationsSchema = z
	.object({
		groups: z
			.array(MenuVariationGroupSchema)
			.max(3, 'Use up to three variation groups'),
		variants: z
			.array(MenuVariationSchema)
			.max(100, 'Use up to 100 combinations'),
	})
	.superRefine((data, context) => {
		const names = new Set<string>()
		const groupIds = new Set<string>()
		let combinations = 1
		for (const group of data.groups) {
			if (groupIds.has(group.id))
				context.addIssue({
					code: 'custom',
					message: 'Variation group IDs must be unique',
				})
			groupIds.add(group.id)
			const name = group.name.toLocaleLowerCase()
			if (names.has(name))
				context.addIssue({
					code: 'custom',
					message: 'Variation names must be unique',
				})
			names.add(name)
			const values = new Set<string>()
			const valueIds = new Set<string>()
			for (const value of group.values) {
				if (valueIds.has(value.id))
					context.addIssue({
						code: 'custom',
						message: `Option IDs in ${group.name} must be unique`,
					})
				valueIds.add(value.id)
				const valueName = value.name.toLocaleLowerCase()
				if (values.has(valueName))
					context.addIssue({
						code: 'custom',
						message: `Options in ${group.name} must be unique`,
					})
				values.add(valueName)
			}
			combinations *= group.values.length
		}
		if (combinations > 100)
			context.addIssue({
				code: 'custom',
				message: 'Use up to 100 combinations',
			})
		if (data.variants.length !== (data.groups.length ? combinations : 0)) {
			context.addIssue({
				code: 'custom',
				message: 'Every option combination needs a price',
			})
		}
		const seen = new Set<string>()
		const variantIds = new Set<string>()
		for (const variant of data.variants) {
			if (variantIds.has(variant.id))
				context.addIssue({
					code: 'custom',
					message: 'Variation IDs must be unique',
				})
			variantIds.add(variant.id)
			const valid =
				variant.valueIds.length === data.groups.length &&
				variant.valueIds.every((id, index) =>
					data.groups[index]?.values.some((value) => value.id === id),
				)
			const key = variant.valueIds.join('\u0000')
			if (!valid || seen.has(key))
				context.addIssue({
					code: 'custom',
					message: 'Invalid or duplicate variation combination',
				})
			seen.add(key)
		}
	})

export type MenuVariations = z.infer<typeof MenuVariationsSchema>

export function reconcileMenuVariations(
	current: MenuVariations,
	groups: MenuVariations['groups'],
	defaultPrice: number,
	createId: () => string = () => crypto.randomUUID(),
): MenuVariations {
	if (groups.length === 0) return { groups, variants: [] }
	const existing = new Map(
		current.variants.map((variant) => [
			variant.valueIds.join('\u0000'),
			variant,
		]),
	)
	const sameGroups =
		current.groups.length === groups.length &&
		groups.every((group, index) => group.id === current.groups[index]?.id)
	const sharedGroups = groups.flatMap((group, newIndex) => {
		const oldIndex = current.groups.findIndex((entry) => entry.id === group.id)
		return oldIndex < 0 ? [] : [{ oldIndex, newIndex }]
	})
	const usedIds = new Set<string>()
	const combinations = groups.reduce<string[][]>(
		(rows, group) =>
			rows.flatMap((ids) => group.values.map((value) => [...ids, value.id])),
		[[]],
	)
	return {
		groups,
		variants: combinations.map((valueIds) => {
			const exact = sameGroups
				? existing.get(valueIds.join('\u0000'))
				: undefined
			if (exact) {
				usedIds.add(exact.id)
				return exact
			}
			const inherited =
				sharedGroups.length > 0 && !sameGroups
					? current.variants.find((variant) =>
							sharedGroups.every(
								({ oldIndex, newIndex }) =>
									variant.valueIds[oldIndex] === valueIds[newIndex],
							),
						)
					: undefined
			const id =
				inherited && !usedIds.has(inherited.id) ? inherited.id : createId()
			usedIds.add(id)
			return {
				id,
				valueIds,
				price: inherited?.price ?? defaultPrice,
				imageKey: inherited?.imageKey ?? null,
				availabilityStatus: 'available',
				unavailableUntil: null,
			}
		}),
	}
}

export function parseMenuVariations(
	value: string | null | undefined,
): MenuVariations {
	try {
		const parsed = MenuVariationsSchema.safeParse(JSON.parse(value || '{}'))
		if (parsed.success) return parsed.data
	} catch {}
	return { groups: [], variants: [] }
}

// HTML forms submit the empty string for cleared optional controls. Treat that
// as "no value" instead of coercing it into an Invalid Date / NaN, while still
// rejecting genuinely malformed input (e.g. `"not-a-date"`).
const emptyStringToNull = (value: unknown) =>
	value === '' || value === undefined ? null : value

const OptionalDateInputSchema = z.preprocess(
	emptyStringToNull,
	z.coerce.date().nullable(),
)

const OptionalCountInputSchema = z.preprocess(
	emptyStringToNull,
	z.coerce.number().int().min(0).nullable(),
)

const LocationOverrideInputSchema = z.object({
	locationId: z.string(),
	isEnabled: z.boolean().nullable().optional(),
	price: z.coerce.number().min(0).nullable().optional(),
	availabilityStatus: AvailabilityStatusSchema.nullable().optional(),
	unavailableUntil: OptionalDateInputSchema,
})

export const ModifierOptionInputSchema = z.object({
	id: z.string().optional(),
	displayName: z.string().min(1, 'Display name is required'),
	internalName: z.string().optional(),
	description: z.string().optional(),
	imageKey: z.string().optional().nullable(),
	price: z.coerce.number().finite().min(0).default(0),
	priceWhole: z.coerce.number().finite().min(0).optional().nullable(),
	priceLeft: z.coerce.number().finite().min(0).optional().nullable(),
	priceRight: z.coerce.number().finite().min(0).optional().nullable(),
	minSelections: z.coerce.number().int().min(0).default(0),
	maxSelections: OptionalCountInputSchema,
	isAlcohol: z.boolean().default(false),
	isGlutenFree: z.boolean().default(false),
	isVegetarian: z.boolean().default(false),
	isTopping: z.boolean().default(false),
	isDefault: z.boolean().default(false),
	allergens: z.array(AllergenSchema).default([]),
	applySalesTax: z.boolean().default(true),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	nestedModifierGroupIds: z.array(z.string()).default([]),
	position: z.number().default(0),
})

export type ModifierOptionInput = z.infer<typeof ModifierOptionInputSchema>

export const MenuOptionInputSchema = z.object({
	id: z.string().optional(),
	displayName: z.string().min(1, 'Display name is required'),
	internalName: z.string().optional(),
	description: z.string().optional(),
	imageKey: z.string().optional().nullable(),
	imageUrl: z.string().optional().nullable(),
	price: z.coerce.number().finite().min(0).default(0),
	priceWhole: z.coerce.number().finite().min(0).optional().nullable(),
	priceLeft: z.coerce.number().finite().min(0).optional().nullable(),
	priceRight: z.coerce.number().finite().min(0).optional().nullable(),
	calories: OptionalCountInputSchema,
	minSelections: z.coerce.number().int().min(0).default(0),
	maxSelections: OptionalCountInputSchema,
	isAlcohol: z.boolean().default(false),
	isGlutenFree: z.boolean().default(false),
	isVegetarian: z.boolean().default(false),
	isTopping: z.boolean().default(false),
	allergens: z.array(AllergenSchema).default([]),
	applySalesTax: z.boolean().default(true),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	modifierGroupIds: z.array(z.string()).default([]),
	nestedModifierGroupIds: z.array(z.string()).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type MenuOptionInput = z.infer<typeof MenuOptionInputSchema>

export const ModifierGroupInputSchema = z.object({
	id: z.string().optional(),
	name: z.string().min(1, 'Group name is required'),
	internalName: z.string().optional(),
	selectionType: ModifierSelectionTypeSchema.default('single'),
	minSelections: z.coerce.number().int().min(0).default(0),
	maxSelections: OptionalCountInputSchema,
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	options: z.array(ModifierOptionInputSchema).default([]),
	optionIds: z.array(z.string()).default([]),
	assignedItemIds: z.array(z.string()).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type ModifierGroupInput = z.infer<typeof ModifierGroupInputSchema>

export const MenuItemInputSchema = z.object({
	id: z.string().optional(),
	displayName: z.string().min(1, 'Display name is required'),
	internalName: z.string().optional(),
	description: z.string().optional(),
	price: z.coerce.number().finite().min(0, 'Price must be positive'),
	imageKey: z.string().optional().nullable(),
	imageUrl: z.string().optional().nullable(),
	imageKeys: z.array(z.string()).max(5).default([]),
	variations: MenuVariationsSchema.default({ groups: [], variants: [] }),
	isAlcohol: z.boolean().default(false),
	isGlutenFree: z.boolean().default(false),
	isVegetarian: z.boolean().default(false),
	allergens: z.array(AllergenSchema).default([]),
	calorieMin: OptionalCountInputSchema,
	calorieMax: OptionalCountInputSchema,
	applySalesTax: z.boolean().default(true),
	excludeFromOverride: z.boolean().default(false),
	isPopular: z.boolean().default(false),
	isUpsell: z.boolean().default(false),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	categoryIds: z.array(z.string()).default([]),
	assignedCategoryIds: z.array(z.string()).default([]),
	modifierGroupIds: z.array(z.string()).default([]),
	assignedModifierGroupIds: z.array(z.string()).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type MenuItemInput = z.infer<typeof MenuItemInputSchema>

/**
 * Menu items may have a small, ordered gallery. The legacy imageKey remains
 * the gallery's primary image so older consumers continue to work.
 */
export function parseMenuItemImageKeys(
	rawImageKeys: string | null | undefined,
	legacyImageKey: string | null | undefined,
): string[] {
	let imageKeys: unknown = []

	try {
		imageKeys = JSON.parse(rawImageKeys || '[]')
	} catch {}

	const normalized = Array.isArray(imageKeys)
		? imageKeys
				.filter((imageKey): imageKey is string => typeof imageKey === 'string')
				.map((imageKey) => imageKey.trim())
				.filter(Boolean)
		: []

	if (normalized.length === 0 && legacyImageKey) {
		normalized.push(legacyImageKey)
	}

	return Array.from(new Set(normalized)).slice(0, 5)
}

export const MenuCategoryInputSchema = z.object({
	id: z.string().optional(),
	parentId: z.string().nullable().optional(),
	displayName: z.string().min(1, 'Display name is required'),
	internalName: z.string().optional(),
	description: z.string().optional(),
	upsellCategoryIds: z.array(z.string()).default([]),
	availabilityHours: z.string().optional().nullable(),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	excludeFromOverride: z.boolean().default(false),
	itemIds: z.array(z.string()).default([]),
	menuIds: z.array(z.string()).default([]),
	assignedItemIds: z.array(z.string()).default([]),
	assignedMenuIds: z.array(z.string()).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type MenuCategoryInput = z.infer<typeof MenuCategoryInputSchema>

export const MenuInputSchema = z.object({
	id: z.string().optional(),
	displayName: z.string().min(1, 'Display name is required'),
	internalName: z.string().optional(),
	menuType: MenuTypeSchema.default('online_pos_kiosk'),
	nutritionalInfo: z.boolean().default(true),
	specialInstructions: z.boolean().default(true),
	availabilityHours: z.string().optional().nullable(),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	categoryIds: z.array(z.string()).default([]),
	assignedCategoryIds: z.array(z.string()).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type MenuInput = z.infer<typeof MenuInputSchema>

export * from './location-availability.ts'

export interface CategoryHierarchyNode {
	id: string
	parentId: string | null
	displayName: string
}

export function getCategoryDepth(
	categoryId: string,
	categoriesMap: Map<string, { id: string; parentId?: string | null }>,
): number {
	let depth = 1
	let currentId: string | null | undefined = categoryId
	const visited = new Set<string>()

	while (currentId) {
		if (visited.has(currentId)) {
			return -1
		}
		visited.add(currentId)
		const cat = categoriesMap.get(currentId)
		if (!cat || !cat.parentId) break
		depth++
		currentId = cat.parentId
	}
	return depth
}

export function isValidParentCategory(
	categoryId: string | null | undefined,
	proposedParentId: string | null | undefined,
	allCategories: Array<{ id: string; parentId?: string | null }>,
	maxDepth = 3,
): { valid: boolean; reason?: string } {
	if (!proposedParentId) return { valid: true }
	if (categoryId && proposedParentId === categoryId) {
		return { valid: false, reason: 'A category cannot be its own parent.' }
	}

	const map = new Map(allCategories.map((c) => [c.id, c]))
	if (!map.has(proposedParentId)) {
		return { valid: false, reason: 'Parent category does not exist.' }
	}

	if (categoryId) {
		let curr: string | null | undefined = proposedParentId
		const seen = new Set<string>()
		while (curr) {
			if (curr === categoryId) {
				return {
					valid: false,
					reason: 'Cannot set a descendant category as parent.',
				}
			}
			if (seen.has(curr)) break
			seen.add(curr)
			curr = map.get(curr)?.parentId
		}
	}

	const parentDepth = getCategoryDepth(proposedParentId, map)
	if (parentDepth < 0) {
		return {
			valid: false,
			reason: 'Circular hierarchy detected in parent chain.',
		}
	}

	function getMaxSubtreeDepth(rootId: string): number {
		let maxSub = 0
		for (const c of allCategories) {
			if (c.parentId === rootId) {
				maxSub = Math.max(maxSub, 1 + getMaxSubtreeDepth(c.id))
			}
		}
		return maxSub
	}

	const subtreeDepth = categoryId ? getMaxSubtreeDepth(categoryId) : 0
	if (parentDepth + 1 + subtreeDepth > maxDepth) {
		return {
			valid: false,
			reason: `Categories are limited to a maximum of ${maxDepth} levels.`,
		}
	}

	return { valid: true }
}
