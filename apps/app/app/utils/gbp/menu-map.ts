/**
 * Menuza menu to Google food menus (#208). Pure: no I/O. It reads the public
 * menu payload (what the website shows) for ONE location and returns the
 * `foodMenus` body plus the dishes that were left out and why.
 *
 * Only what the website shows goes to Google: a dish hidden, unavailable or
 * disabled at the location is skipped (and listed). Prices follow the same
 * resolver every channel uses (`resolveMenuItemPrice`): a location's fixed
 * price, else the pricing rules, in the location's currency.
 */
import { resolveMenuItemPrice } from '@repo/common/menu-pricing'
import { type DietaryTag, dietaryTagsOf } from '@repo/common/menu-types'
import {
	type PublicMenuCategoryData,
	type PublicMenuItemData,
	type PublicSiteMenuPayload,
} from '#app/utils/menu/public-menu-context.server.ts'

export type MenuSkipReason =
	| 'hidden_at_location'
	| 'unavailable'
	| 'alcohol_restricted'
	| 'no_price'
	| 'empty_section'

export type SkippedDish = { name: string; reason: MenuSkipReason }

export type GoogleFoodMenu = {
	labels: Array<{
		displayName: string
		description?: string
		languageCode: string
	}>
	sections: Array<{
		labels: Array<{
			displayName: string
			description?: string
			languageCode: string
		}>
		items: Array<{
			labels: Array<{
				displayName: string
				description?: string
				languageCode: string
			}>
			attributes: {
				price?: { currencyCode: string; units: string; nanos: number }
				dietaryRestriction?: string[]
				allergen?: string[]
				spiciness?: string
			}
		}>
	}>
}

export type BuiltFoodMenus = {
	menus: GoogleFoodMenu[]
	dishCount: number
	sectionCount: number
	skipped: SkippedDish[]
}

const DIETARY_MAP: Partial<Record<DietaryTag, string>> = {
	vegetarian: 'VEGETARIAN',
	vegan: 'VEGAN',
	gluten_free: 'GLUTEN_FREE',
	halal: 'HALAL',
	dairy_free: 'DAIRY_FREE',
	nut_free: 'NUT_FREE',
}

const ALLERGEN_MAP: Record<string, string> = {
	dairy: 'DAIRY',
	milk: 'DAIRY',
	egg: 'EGG',
	eggs: 'EGG',
	fish: 'FISH',
	gluten: 'GLUTEN',
	peanut: 'PEANUT',
	peanuts: 'PEANUT',
	shellfish: 'SHELLFISH',
	soy: 'SOY',
	tree_nut: 'TREE_NUT',
	tree_nuts: 'TREE_NUT',
	nuts: 'TREE_NUT',
	wheat: 'WHEAT',
	sesame: 'SESAME',
}

/** Splits a major-unit price into Google's `units` and `nanos`. */
export function googleMoney(amount: number, currencyCode: string) {
	const cents = Math.round(amount * 100)
	const units = Math.trunc(cents / 100)
	const rest = cents - units * 100
	return {
		currencyCode,
		units: String(units),
		nanos: rest * 10_000_000,
	}
}

type Override = NonNullable<
	PublicSiteMenuPayload['locationOverrides'][string]
>[number]

function overrideOf(
	overrides: readonly Override[],
	entityType: string,
	entityId: string,
): Override | undefined {
	return overrides.find(
		(entry) => entry.entityType === entityType && entry.entityId === entityId,
	)
}

function flattenCategories(
	categories: readonly PublicMenuCategoryData[],
): PublicMenuCategoryData[] {
	return categories.flatMap((category) => [
		category,
		...flattenCategories(category.subcategories ?? []),
	])
}

export function buildFoodMenus(input: {
	payload: PublicSiteMenuPayload
	locationId: string
	languageCode: string
	/** KSA: alcohol is never published. */
	restrictAlcohol: boolean
	now?: Date
}): BuiltFoodMenus {
	const { payload, locationId, languageCode } = input
	const location = payload.locations.find((entry) => entry.id === locationId)
	const currency = location?.currency ?? payload.organization.currency
	const overrides = payload.locationOverrides[locationId] ?? []
	const skipped: SkippedDish[] = []
	const menus: GoogleFoodMenu[] = []
	let dishCount = 0
	let sectionCount = 0

	for (const menu of payload.menus) {
		const menuOverride = overrideOf(overrides, 'menu', menu.id)
		if (menuOverride?.isEnabled === false) continue
		if (menu.availabilityStatus !== 'available') continue
		const sections: GoogleFoodMenu['sections'] = []
		for (const category of flattenCategories(menu.categories)) {
			const categoryOverride = overrideOf(overrides, 'category', category.id)
			const categoryHidden =
				categoryOverride?.isEnabled === false ||
				(category.availabilityStatus !== 'available' &&
					category.items.length > 0)
			const items: GoogleFoodMenu['sections'][number]['items'] = []
			for (const item of category.items) {
				const skip = skipReason(item, {
					overrides,
					categoryHidden,
					restrictAlcohol: input.restrictAlcohol,
				})
				if (skip) {
					skipped.push({ name: item.displayName, reason: skip })
					continue
				}
				const override = overrideOf(overrides, 'item', item.id)
				const variantPrices = item.variations.variants
					.filter((variant) => variant.availabilityStatus === 'available')
					.map((variant) => variant.price)
				const price = resolveMenuItemPrice(
					{ price: item.price, orderTypePrices: item.orderTypePrices },
					{
						orderType: 'dine_in',
						locationId,
						rules: payload.pricingRules ?? null,
						now: input.now,
					},
					{
						overridePrice: override?.price ?? null,
						variantPrice:
							variantPrices.length > 0 ? Math.min(...variantPrices) : null,
					},
				)
				if (!(price > 0)) {
					skipped.push({ name: item.displayName, reason: 'no_price' })
					continue
				}
				const dietary = dietaryTagsOf(item)
					.map((tag) => DIETARY_MAP[tag])
					.filter((value): value is string => Boolean(value))
				const allergens = [
					...new Set(
						item.allergens
							.map(
								(allergen) =>
									ALLERGEN_MAP[
										allergen
											.trim()
											.toLowerCase()
											.replace(/[\s-]+/g, '_')
									],
							)
							.filter((value): value is string => Boolean(value)),
					),
				]
				items.push({
					labels: [
						{
							displayName: item.displayName.slice(0, 140),
							...(item.description
								? { description: item.description.slice(0, 1000) }
								: {}),
							languageCode,
						},
					],
					attributes: {
						price: googleMoney(price, currency),
						...(dietary.length > 0 ? { dietaryRestriction: dietary } : {}),
						...(allergens.length > 0 ? { allergen: allergens } : {}),
						...(dietaryTagsOf(item).includes('spicy')
							? { spiciness: 'MEDIUM' }
							: {}),
					},
				})
				dishCount += 1
			}
			if (items.length === 0) {
				if (category.items.length > 0 && !categoryHidden) {
					// Every dish was skipped; the dishes are already listed.
				}
				continue
			}
			sections.push({
				labels: [
					{
						displayName: category.displayName.slice(0, 140),
						...(category.description
							? { description: category.description.slice(0, 1000) }
							: {}),
						languageCode,
					},
				],
				items,
			})
			sectionCount += 1
		}
		if (sections.length === 0) continue
		menus.push({
			labels: [{ displayName: menu.displayName.slice(0, 140), languageCode }],
			sections,
		})
	}
	return { menus, dishCount, sectionCount, skipped }
}

function skipReason(
	item: PublicMenuItemData,
	context: {
		overrides: readonly Override[]
		categoryHidden: boolean
		restrictAlcohol: boolean
	},
): MenuSkipReason | null {
	if (context.categoryHidden) return 'hidden_at_location'
	const override = overrideOf(context.overrides, 'item', item.id)
	if (override?.isEnabled === false) return 'hidden_at_location'
	const status = override?.availabilityStatus ?? item.availabilityStatus
	if (status && status !== 'available') return 'unavailable'
	if (context.restrictAlcohol && item.isAlcohol) return 'alcohol_restricted'
	return null
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export const MAX_DISH_PHOTOS = 20

export type PhotoCategory = 'FOOD_AND_DRINK' | 'COVER' | 'PROFILE'

export type PhotoSkipReason =
	| 'unsupported_type'
	| 'too_small'
	| 'file_too_small'
	| 'file_too_large'
	| 'size_unknown'
	| 'missing'

const MIN_SIZE: Record<PhotoCategory, { width: number; height: number }> = {
	FOOD_AND_DRINK: { width: 250, height: 250 },
	PROFILE: { width: 250, height: 250 },
	COVER: { width: 480, height: 270 },
}
const MIN_BYTES = 10 * 1024
const MAX_BYTES = 5 * 1024 * 1024

/** Why Google would refuse this library photo, or null when it is fine. */
export function photoSkipReason(
	asset: {
		mimeType: string
		width: number | null
		height: number | null
		fileSize: number | null
	} | null,
	category: PhotoCategory,
): PhotoSkipReason | null {
	if (!asset) return 'missing'
	if (!['image/jpeg', 'image/jpg', 'image/png'].includes(asset.mimeType)) {
		return 'unsupported_type'
	}
	if (!asset.width || !asset.height) return 'size_unknown'
	const min = MIN_SIZE[category]
	if (asset.width < min.width || asset.height < min.height) return 'too_small'
	if (asset.fileSize !== null) {
		if (asset.fileSize < MIN_BYTES) return 'file_too_small'
		if (asset.fileSize > MAX_BYTES) return 'file_too_large'
	}
	return null
}
