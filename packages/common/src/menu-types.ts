import { z } from 'zod'
import { parseLocalizedString } from './site-locales.ts'

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
	'hidden',
] as const

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number]

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
	available: 'Available',
	unavailable_until: 'Unavailable until',
	unavailable_until_tomorrow: 'Unavailable until tomorrow',
	unavailable: 'Unavailable',
	hidden: 'Hidden',
}

export const MENU_TYPES = ['online_pos_kiosk', 'catering', 'drop'] as const
export type MenuType = (typeof MENU_TYPES)[number]

export const MENU_TYPE_LABELS: Record<MenuType, string> = {
	online_pos_kiosk: 'Online Ordering / POS / Kiosk',
	catering: 'Catering',
	drop: 'Drop (Limited Time)',
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

// --- Menu Drops System Types ---

export const DROP_STATUSES = [
	'draft',
	'scheduled',
	'live',
	'closed',
	'completed',
] as const
export type DropStatus = (typeof DROP_STATUSES)[number]

export const DROP_STATUS_LABELS: Record<DropStatus, string> = {
	draft: 'Draft',
	scheduled: 'Scheduled',
	live: 'Live',
	closed: 'Closed',
	completed: 'Closed',
}

// Publication is stored; the customer-facing phase follows the order window.
export function getDropDisplayStatus(
	status: DropStatus,
	ordersOpenAt: Date | string | null | undefined,
	ordersCloseAt: Date | string | null | undefined,
	now: Date = new Date(),
): DropStatus {
	if (status === 'draft') return 'draft'
	if (status === 'completed' || status === 'closed') return 'closed'
	if (ordersCloseAt && new Date(ordersCloseAt) <= now) return 'closed'
	if (ordersOpenAt && new Date(ordersOpenAt) > now) return 'scheduled'
	if (status === 'scheduled' && !ordersOpenAt) return 'scheduled'
	return 'live'
}

export const DROP_VISIBILITIES = ['public', 'unlisted'] as const
export type DropVisibility = (typeof DROP_VISIBILITIES)[number]

export const DROP_VISIBILITY_LABELS: Record<DropVisibility, string> = {
	public: 'Public',
	unlisted: 'Unlisted',
}

// Discovery is separate from access: published unlisted drops still open by URL.
export function isDropDiscoverable(
	status: DropStatus,
	visibility: DropVisibility,
): boolean {
	return status !== 'draft' && visibility === 'public'
}

export const DROP_SLOT_INTERVALS = [15, 30, 45, 60] as const
export const DROP_CHECKOUT_HOLD_OPTIONS = [3, 5, 10, 15] as const

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
			const key = variant.valueIds.join('\0')
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
		current.variants.map((variant) => [variant.valueIds.join('\0'), variant]),
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
			const exact = sameGroups ? existing.get(valueIds.join('\0')) : undefined
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
	nestedModifierGroupIds: z.array(z.string()).max(50).default([]),
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
	modifierGroupIds: z.array(z.string()).max(200).default([]),
	nestedModifierGroupIds: z.array(z.string()).max(50).default([]),
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
	options: z.array(ModifierOptionInputSchema).max(200).default([]),
	optionIds: z.array(z.string()).max(500).default([]),
	assignedItemIds: z.array(z.string()).max(2000).default([]),
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
	categoryIds: z.array(z.string()).max(200).default([]),
	assignedCategoryIds: z.array(z.string()).max(200).default([]),
	modifierGroupIds: z.array(z.string()).max(200).default([]),
	assignedModifierGroupIds: z.array(z.string()).max(200).default([]),
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
	upsellCategoryIds: z.array(z.string()).max(100).default([]),
	availabilityHours: z.string().optional().nullable(),
	availabilityStatus: AvailabilityStatusSchema.default('available'),
	unavailableUntil: OptionalDateInputSchema,
	excludeFromOverride: z.boolean().default(false),
	itemIds: z.array(z.string()).max(2000).default([]),
	menuIds: z.array(z.string()).max(500).default([]),
	assignedItemIds: z.array(z.string()).max(2000).default([]),
	assignedMenuIds: z.array(z.string()).max(500).default([]),
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
	categoryIds: z.array(z.string()).max(500).default([]),
	assignedCategoryIds: z.array(z.string()).max(500).default([]),
	locationOverrides: z
		.record(z.string(), LocationOverrideInputSchema)
		.optional(),
	position: z.number().default(0),
})

export type MenuInput = z.infer<typeof MenuInputSchema>

// --- Menu Drops System Schemas ---

export const DropPickupWindowInputSchema = z.object({
	id: z.string().optional(),
	locationId: z.string().min(1, 'Location is required'),
	date: z.string().min(1, 'Date is required'),
	startTime: z.string().min(1, 'Start time is required'),
	endTime: z.string().min(1, 'End time is required'),
	slotIntervalMinutes: z.coerce.number().int().positive().default(30),
	maxOrdersPerSlot: OptionalCountInputSchema,
	orderLeadTimeMinutes: z.coerce.number().int().min(0).default(0),
})

export type DropPickupWindowInput = z.infer<typeof DropPickupWindowInputSchema>

export const DropInventoryInputSchema = z.object({
	id: z.string().optional(),
	entityType: z.enum(['item', 'category']),
	entityId: z.string().min(1),
	inventory: OptionalCountInputSchema,
	maxPerOrder: OptionalCountInputSchema,
	maxPerPickupSlot: OptionalCountInputSchema,
})

export type DropInventoryInput = z.infer<typeof DropInventoryInputSchema>

export const DropReminderInputSchema = z.object({
	id: z.string().optional(),
	title: z.string().min(1, 'Title is required'),
	message: z.string().optional().nullable(),
	triggerType: z.enum(['before_open', 'before_close', 'custom']),
	scheduledAt: z.coerce.date(),
	status: z.enum(['pending', 'sent', 'cancelled']).default('pending'),
})

export type DropReminderInput = z.infer<typeof DropReminderInputSchema>

export const DropInputSchema = z.object({
	id: z.string().optional(),
	menuId: z.string().min(1, 'Please select a menu for this drop'),
	title: z
		.string()
		.trim()
		.min(1, 'Drop title is required')
		.max(3000)
		.refine(
			(value) =>
				Object.values(parseLocalizedString(value)).every(
					(translation) => (translation?.length ?? 0) <= 150,
				),
			'Each drop title translation must be 150 characters or fewer',
		),
	slug: z.string().trim().min(1).max(150).optional(),
	description: z.string().optional().nullable(),
	coverImageKey: z.string().optional().nullable(),
	coverImageUrl: z.string().optional().nullable(),
	status: z.enum(DROP_STATUSES).default('draft'),
	ordersOpenAt: OptionalDateInputSchema,
	ordersCloseAt: OptionalDateInputSchema,
	visibility: z.enum(DROP_VISIBILITIES).default('public'),
	checkoutHoldMinutes: z.coerce.number().int().positive().default(5),
	showOrdersOpenTime: z.boolean().default(true),
	showMenuPreview: z.boolean().default(true),
	showInventoryRemaining: z.boolean().default(true),
	includeGiftCard: z.boolean().default(false),
	pickupWindows: z.array(DropPickupWindowInputSchema).max(200).default([]),
	inventoryOverrides: z.array(DropInventoryInputSchema).max(5000).default([]),
	reminders: z.array(DropReminderInputSchema).max(200).default([]),
})

export type DropInput = z.infer<typeof DropInputSchema>

export function hasDropDefaultTitle(
	title: string,
	defaultLocale: string,
): boolean {
	return Boolean(
		parseLocalizedString(title, defaultLocale)[defaultLocale]?.trim(),
	)
}

export function getDropPublicationErrors(
	data: DropInput,
	now: Date = new Date(),
	options: { requireFutureClose?: boolean } = {},
): Record<string, string[]> {
	const errors: Record<string, string[]> = {}
	if (!data.ordersOpenAt) {
		errors.ordersOpenAt = ['Set when orders open before publishing.']
	}
	if (!data.ordersCloseAt) {
		errors.ordersCloseAt = ['Set when orders close before publishing.']
	} else if (
		options.requireFutureClose !== false &&
		data.ordersCloseAt <= now
	) {
		errors.ordersCloseAt = ['The closing time must be in the future.']
	} else if (data.ordersOpenAt && data.ordersCloseAt <= data.ordersOpenAt) {
		errors.ordersCloseAt = ['The closing time must be after the opening time.']
	}
	if (data.pickupWindows.length === 0) {
		errors.pickupWindows = ['Add a pickup window before publishing.']
	}
	return errors
}

export interface PickupSlot {
	time: string
	displayTime: string
}

export function generatePickupSlots(
	startTime: string,
	endTime: string,
	intervalMinutes: number = 30,
): PickupSlot[] {
	const slots: PickupSlot[] = []
	const [startH, startM] = (startTime || '').split(':').map(Number)
	const [endH, endM] = (endTime || '').split(':').map(Number)
	if (
		startH === undefined ||
		startM === undefined ||
		endH === undefined ||
		endM === undefined ||
		isNaN(startH) ||
		isNaN(startM) ||
		isNaN(endH) ||
		isNaN(endM)
	) {
		return []
	}

	let currentMinutes = startH * 60 + startM
	const totalEndMinutes = endH * 60 + endM

	if (intervalMinutes <= 0) return []

	while (currentMinutes + intervalMinutes <= totalEndMinutes) {
		const h = Math.floor(currentMinutes / 60)
		const m = currentMinutes % 60
		const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

		const period = h >= 12 ? 'pm' : 'am'
		const h12 = h % 12 === 0 ? 12 : h % 12
		const displayTime = `${h12}:${m.toString().padStart(2, '0')}${period}`

		slots.push({ time: timeStr, displayTime })
		currentMinutes += intervalMinutes
	}

	return slots
}

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
