import {
	type BusyMode,
	type OrderingPause,
} from '@repo/common/location-availability'
import {
	type DeliveryConfig,
	type DeliveryZone,
	type FulfillmentOptions,
	type InHouseTips,
	type LocationAddress,
	type SchedulingOptions,
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import {
	parseOrderTypePrices,
	type OrderTypePrices,
} from '@repo/common/menu-pricing'
import {
	dietaryTagsOf,
	isUnavailableUntilExpired,
	parseMenuItemImageKeys,
	parseMenuVariations,
	type DietaryTag,
	type MenuVariations,
} from '@repo/common/menu-types'
import {
	type OrderNumberFormat,
	type PosLocationStationSettings,
} from '@repo/common/pos-orders'
import {
	type OrganizationMenuItem,
	type OrganizationMenuModifierGroup,
	type OrganizationMenuModifierGroupOptionAssignment,
	type OrganizationMenuOption,
} from '@repo/database'
import { type InferSelectModel } from 'drizzle-orm'

/**
 * Public (customer-facing) shapes shared by the Sites menu and drop endpoints.
 * `apps/sites/src/lib/org.ts` mirrors these types; keep them in sync.
 */
export interface PublicLocationData {
	id: string
	name: string
	slug: string
	phone: string | null
	timezone: string
	taxRate: number
	/** Menu prices already include tax (VAT); tax is shown, not added. */
	taxInclusive: boolean
	/** Seller's tax (VAT) registration number for receipts, or null. */
	vatNumber: string | null
	address: LocationAddress | null
	currency: 'USD' | 'CAD' | 'SAR'
	storeHours: WeeklySchedule
	onlineHours: WeeklySchedule
	specialHours: SpecialHour[]
	prepTime: number
	fulfillmentOptions: FulfillmentOptions
	inHouseTips: InHouseTips
	/**
	 * The tip buttons per order type (#118), as saved; null until an operator
	 * saves them (checkout then shows the default buttons for the currency).
	 */
	tipSettings: unknown
	scheduling: SchedulingOptions
	deliveryConfig: DeliveryConfig
	deliveryZones: DeliveryZone[]
	isDefault: boolean
	/**
	 * Station offers "Text me when it's ready" here and the region texts counter
	 * and phone orders when Kitchen marks them ready (US organizations only).
	 */
	readyText: boolean
	/** Table-service courses (#290). Null when off. */
	courses?: {
		enabled: boolean
		autoFireMinutes?: number | null
		courses: Array<{ id: string; name: string }>
	} | null
	/** Active "pause online orders" (web and QR), or null. */
	orderingPause: OrderingPause | null
	/** Active busy mode (extra prep minutes), or null. */
	busyMode: BusyMode | null
	onlineOrderingSettings?: unknown
	slotLimitSettings?: unknown
	prepSchedule?: unknown
	prayerPauseSettings?: unknown
	prayerPauseRegion?: boolean
	/** Per-location Station register policy (#372, #171, #380). */
	stationSettings?: PosLocationStationSettings
	/** Per-location order number format and daily reset (#371). */
	orderNumberFormat?: OrderNumberFormat
}

export interface PublicMenuOptionData {
	id: string
	displayName: string
	internalName: string | null
	kitchenName?: string | null
	kitchenHighlight?: string | null
	description: string | null
	imageKey: string | null
	imageUrl: string | null
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	calories: number | null
	minSelections: number
	maxSelections: number | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	/** Dietary tags (#335). Older readers keep using the flags. */
	dietaryTags?: DietaryTag[]
	/** Prices per order type (#412); absent when none is set. */
	orderTypePrices?: OrderTypePrices
	isTopping: boolean
	isDefault: boolean
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	position: number
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupData[]
}

export interface PublicModifierGroupData {
	id: string
	name: string
	internalName: string | null
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	position: number
	options: PublicMenuOptionData[]
}

export interface PublicMenuItemData {
	id: string
	displayName: string
	internalName: string | null
	kitchenName?: string | null
	kitchenHighlight?: string | null
	description: string | null
	price: number
	imageKey: string | null
	imageUrl: string | null
	imageKeys: string[]
	imageUrls: string[]
	variations: {
		groups: Array<{
			id: string
			name: string
			values: Array<{ id: string; name: string }>
		}>
		variants: Array<{
			id: string
			valueIds: string[]
			price: number
			imageUrl: string | null
			excludeFromDiscounts?: boolean
			availabilityStatus: 'available' | 'unavailable'
		}>
	}
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	/** Dietary tags (#335). Older readers keep using the flags. */
	dietaryTags?: DietaryTag[]
	/**
	 * Prices per order type (#412); absent when none is set. Dishes with
	 * variations price from their variation instead.
	 */
	orderTypePrices?: OrderTypePrices
	/** Never receives any discount (read defensively by the regional engine). */
	excludeFromDiscounts?: boolean
	/** Does not count toward order slot limits (#256). */
	excludeFromOrderLimits?: boolean
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
	position: number
	modifierGroups: PublicModifierGroupData[]
}

export interface PublicMenuCategoryData {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	defaultCourseId?: string | null
	parentId?: string | null
	subcategories?: PublicMenuCategoryData[]
	upsellCategoryIds: string[]
	availabilityStatus: string
	position: number
	excludeFromOrderLimits?: boolean
	items: PublicMenuItemData[]
}

export interface PublicMenuData {
	id: string
	displayName: string
	internalName: string | null
	menuType: string
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus: string
	position: number
	categories: PublicMenuCategoryData[]
}

export type MenuOptionRow = InferSelectModel<typeof OrganizationMenuOption>
export type MenuOptionAssignmentRow = Pick<
	InferSelectModel<typeof OrganizationMenuModifierGroupOptionAssignment>,
	| 'priceOverride'
	| 'priceWholeOverride'
	| 'priceLeftOverride'
	| 'priceRightOverride'
	| 'isDefault'
>
export type MenuModifierGroupRow = InferSelectModel<
	typeof OrganizationMenuModifierGroup
>
export type MenuItemRow = InferSelectModel<typeof OrganizationMenuItem>

/** Maps media asset ids and object keys to public image URLs. */
export type MediaUrlMap = ReadonlyMap<string, string>

/** `{ orderTypePrices }` only when one is set, so the payload stays small. */
function orderTypePricesField(raw: string | null | undefined): {
	orderTypePrices?: OrderTypePrices
} {
	const prices = parseOrderTypePrices(raw)
	return prices ? { orderTypePrices: prices } : {}
}

export function safeJsonParse<T>(
	raw: string | null | undefined,
	fallback: T,
): T {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

export function effectiveAvailabilityStatus(
	status: string,
	unavailableUntil: Date | string | number | null | undefined,
	now: Date,
): string {
	return isUnavailableUntilExpired(status, unavailableUntil, now)
		? 'available'
		: status
}

export function serializePublicOption(
	opt: MenuOptionRow,
	mediaMap: MediaUrlMap,
	now: Date,
): PublicMenuOptionData {
	return {
		id: opt.id,
		displayName: opt.displayName,
		internalName: opt.internalName,
		kitchenName: opt.kitchenName,
		kitchenHighlight: opt.kitchenHighlight,
		description: opt.description,
		imageKey: opt.imageKey,
		imageUrl: opt.imageKey ? (mediaMap.get(opt.imageKey) ?? null) : null,
		price: opt.price,
		priceWhole: opt.priceWhole,
		priceLeft: opt.priceLeft,
		priceRight: opt.priceRight,
		calories: opt.calories,
		minSelections: opt.minSelections,
		maxSelections: opt.maxSelections,
		isAlcohol: Boolean(opt.isAlcohol),
		isGlutenFree: Boolean(opt.isGlutenFree),
		isVegetarian: Boolean(opt.isVegetarian),
		dietaryTags: dietaryTagsOf(opt),
		...orderTypePricesField(opt.orderTypePrices),
		isTopping: Boolean(opt.isTopping),
		isDefault: false,
		nestedModifierGroupIds: safeJsonParse<string[]>(
			opt.nestedModifierGroupIds,
			[],
		),
		allergens: safeJsonParse<string[]>(opt.allergens, []),
		applySalesTax: Boolean(opt.applySalesTax),
		availabilityStatus: effectiveAvailabilityStatus(
			opt.availabilityStatus,
			opt.unavailableUntil,
			now,
		),
		position: opt.position,
	}
}

/** Applies a group's per-option price overrides and default flag. */
export function applyOptionAssignment(
	option: PublicMenuOptionData,
	assignment: MenuOptionAssignmentRow,
): PublicMenuOptionData {
	// A group's own price for the option is fixed: the option's order-type
	// prices (#412) do not apply inside that group.
	const { orderTypePrices, ...rest } = option
	return {
		...(assignment.priceOverride != null
			? rest
			: { ...rest, ...(orderTypePrices ? { orderTypePrices } : {}) }),
		price: assignment.priceOverride ?? option.price,
		priceWhole: assignment.priceWholeOverride ?? option.priceWhole,
		priceLeft: assignment.priceLeftOverride ?? option.priceLeft,
		priceRight: assignment.priceRightOverride ?? option.priceRight,
		isDefault: Boolean(assignment.isDefault),
	}
}

export function serializePublicModifierGroup(
	group: MenuModifierGroupRow,
	options: PublicMenuOptionData[],
	now: Date,
): PublicModifierGroupData {
	return {
		id: group.id,
		name: group.name,
		internalName: group.internalName,
		selectionType:
			group.selectionType as PublicModifierGroupData['selectionType'],
		minSelections: group.minSelections,
		maxSelections: group.maxSelections,
		availabilityStatus: effectiveAvailabilityStatus(
			group.availabilityStatus,
			group.unavailableUntil,
			now,
		),
		position: group.position,
		options,
	}
}

/**
 * Resolves `nestedModifierGroupIds` on every option into `nestedModifierGroups`
 * using the given lookup. Groups missing from the lookup are skipped.
 */
export function attachNestedModifierGroups(
	groups: Iterable<PublicModifierGroupData>,
	groupsById: ReadonlyMap<string, PublicModifierGroupData>,
): void {
	for (const group of groups) {
		for (const opt of group.options) {
			if (opt.nestedModifierGroupIds && opt.nestedModifierGroupIds.length > 0) {
				opt.nestedModifierGroups = opt.nestedModifierGroupIds
					.map((gId) => groupsById.get(gId))
					.filter(Boolean) as PublicModifierGroupData[]
			}
		}
	}
}

/**
 * Earliest future `unavailableUntil` among an item's variants, as epoch ms, or
 * null. Callers use it to shorten cache TTLs so sold-out variants return on time.
 */
export function getNextVariationExpiry(
	variations: MenuVariations,
	now: Date,
): number | null {
	let next: number | null = null
	for (const variant of variations.variants) {
		if (
			variant.availabilityStatus !== 'unavailable_until' ||
			!variant.unavailableUntil
		)
			continue
		const expiresAt = new Date(variant.unavailableUntil).getTime()
		if (expiresAt > now.getTime()) next = Math.min(next ?? expiresAt, expiresAt)
	}
	return next
}

export function serializePublicMenuItem(
	item: MenuItemRow,
	modifierGroups: PublicModifierGroupData[],
	mediaMap: MediaUrlMap,
	now: Date,
): PublicMenuItemData {
	const imageKeys = parseMenuItemImageKeys(item.imageKeys, item.imageKey)
	const variations = parseMenuVariations(item.variations)
	const effectiveVariants = variations.variants.map((variant) => ({
		...variant,
		availabilityStatus: isUnavailableUntilExpired(
			variant.availabilityStatus,
			variant.unavailableUntil,
			now,
		)
			? ('available' as const)
			: ('unavailable' as const),
	}))
	const availableVariants = effectiveVariants.filter(
		(variant) => variant.availabilityStatus === 'available',
	)
	const imageUrls = imageKeys.flatMap((imageKey) => {
		const imageUrl = mediaMap.get(imageKey)
		return imageUrl ? [imageUrl] : []
	})

	return {
		id: item.id,
		displayName: item.displayName,
		internalName: item.internalName,
		kitchenName: item.kitchenName,
		kitchenHighlight: item.kitchenHighlight,
		description: item.description,
		price: availableVariants.length
			? Math.min(...availableVariants.map((variant) => variant.price))
			: item.price,
		imageKey: imageKeys[0] ?? null,
		imageUrl: imageUrls[0] ?? null,
		imageKeys,
		imageUrls,
		variations: {
			groups: variations.groups,
			variants: effectiveVariants.map((variant) => ({
				id: variant.id,
				valueIds: variant.valueIds,
				price: variant.price,
				excludeFromDiscounts: variant.excludeFromDiscounts === true,
				availabilityStatus: variant.availabilityStatus,
				imageUrl: variant.imageKey
					? (mediaMap.get(variant.imageKey) ?? null)
					: null,
			})),
		},
		isAlcohol: Boolean(item.isAlcohol),
		isGlutenFree: Boolean(item.isGlutenFree),
		isVegetarian: Boolean(item.isVegetarian),
		dietaryTags: dietaryTagsOf(item),
		...(variations.variants.length > 0
			? {}
			: orderTypePricesField(item.orderTypePrices)),
		excludeFromDiscounts: Boolean(item.excludeFromDiscounts),
		excludeFromOrderLimits: Boolean(item.excludeFromOrderLimits),
		allergens: safeJsonParse<string[]>(item.allergens, []),
		calorieMin: item.calorieMin,
		calorieMax: item.calorieMax,
		isPopular: Boolean(item.isPopular),
		isUpsell: Boolean(item.isUpsell),
		availabilityStatus: effectiveAvailabilityStatus(
			item.availabilityStatus,
			item.unavailableUntil,
			now,
		),
		position: item.position,
		modifierGroups,
	}
}
