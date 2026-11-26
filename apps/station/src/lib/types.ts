/**
 * Shapes of the published catalog the POS reads from the App
 * (`GET /resources/sites/menu`). Mirrors apps/sites/src/lib/org.ts; the POS only
 * declares the fields it uses. Prices arrive in major currency units and are
 * converted to integer cents at the edge (see `toCents`).
 */

export type SelectionType = 'single' | 'multiple' | 'quantity' | 'pizza'

import {
	type OrderNumberFormat,
	type PosLocationStationSettings,
} from '@repo/common/pos-orders'

export type KdsStationSummary = { id: string; name: string }

export type MenuOption = {
	id: string
	displayName: string
	/** Localized kitchen name. Absent on a menu published before it. */
	kitchenName?: string | null
	kitchenHighlight?: string | null
	/** Flagged alcohol (#167); absent on an older menu. */
	isAlcohol?: boolean
	price: number
	/**
	 * What the whole topping costs on a pizza when it differs from `price`. The
	 * server prices every whole choice with `priceWhole ?? price`, so the till
	 * does too. Halves are not offered at the till.
	 */
	priceWhole?: number | null
	/** Prices per order type (#412); absent on older menus. */
	orderTypePrices?: unknown
	/** Dietary tags (#335); absent on older menus. */
	dietaryTags?: string[]
	minSelections: number
	maxSelections: number | null
	isDefault: boolean
	applySalesTax: boolean
	availabilityStatus: string
	position: number
	/** EAN, UPC or GTIN (#407). Absent on a menu published before it. */
	barcode?: string | null
	nestedModifierGroups?: ModifierGroup[]
}

export type ModifierGroup = {
	id: string
	name: string
	selectionType: SelectionType
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	position: number
	options: MenuOption[]
}

export type VariationGroup = {
	id: string
	name: string
	values: Array<{ id: string; name: string }>
}

export type Variant = {
	id: string
	valueIds: string[]
	price: number
	availabilityStatus: string
	excludeFromDiscounts?: boolean
}

export type MenuItem = {
	id: string
	displayName: string
	kitchenName?: string | null
	kitchenHighlight?: string | null
	/** From the dish's category when the location uses courses. */
	defaultCourseId?: string | null
	description: string | null
	price: number
	/** EAN, UPC or GTIN (#407). Absent on a menu published before it. */
	barcode?: string | null
	/** Portions still makeable (#473). Absent when nothing should be shown. */
	fewLeft?: number | null
	imageUrl: string | null
	/** Focal point of the photo (#394); absent or null is the centre crop. */
	imageFocal?: { x: number; y: number } | null
	variations: { groups: VariationGroup[]; variants: Variant[] }
	isVegetarian: boolean
	isGlutenFree: boolean
	isAlcohol: boolean
	/** Dietary tags (#335); absent on older menus (the flags above then). */
	dietaryTags?: string[]
	/** Prices per order type (#412); absent on older menus. */
	orderTypePrices?: unknown
	allergens: string[]
	isPopular: boolean
	/** Left out of every discount. Absent on a menu published before the flag. */
	excludeFromDiscounts?: boolean
	availabilityStatus: string
	channels?: readonly string[] | string | null
	position: number
	modifierGroups: ModifierGroup[]
}

export type MenuCategory = {
	id: string
	displayName: string
	defaultCourseId?: string | null
	parentId?: string | null
	subcategories?: MenuCategory[]
	availabilityStatus: string
	channels?: readonly string[] | string | null
	position: number
	items: MenuItem[]
}

export type MenuLocation = {
	id: string
	name: string
	timezone: string
	taxRate: number
	currency: 'USD' | 'CAD' | 'SAR'
	isDefault: boolean
	phone: string | null
	/** Menu prices already include `taxRate` (VAT). Absent in older payloads: false. */
	taxInclusive?: boolean
	/** The seller's VAT registration number, printed on receipts. */
	vatNumber?: string | null
	/** Whether the restaurant takes tips in the house. Absent in older payloads: treat as allowed. */
	inHouseTips?: { pickupTips?: boolean; dineInTips?: boolean }
	/** "Text me when it's ready" is offered at checkout. Absent in older payloads: off. */
	readyText?: boolean
	/** Table-service courses. Absent means off. */
	courses?: {
		enabled: boolean
		autoFireMinutes?: number | null
		courses: Array<{ id: string; name: string }>
	} | null
	/** Per-location register policy (#372, #171, #380). */
	stationSettings?: PosLocationStationSettings
	/** Per-location order number format and daily reset (#371). */
	orderNumberFormat?: OrderNumberFormat
	/** What the receipt codes open (#263); absent on an older menu: no codes. */
	receiptCodes?: { reviewUrl: string | null; appUrl: string | null }
}

export type MenuPayload = {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
		defaultLocale: string
	}
	locations: MenuLocation[]
	menus: Array<{
		id: string
		displayName: string
		menuType: string
		availabilityStatus: string
		channels?: readonly string[] | string | null
		position: number
		categories: MenuCategory[]
	}>
	/** Live pricing rules (#388); read with `parseMenuPricingRules`. */
	pricingRules?: unknown
	locationOverrides: Record<
		string,
		Array<{
			entityType: string
			entityId: string
			isEnabled?: boolean | null
			price?: number | null
			availabilityStatus?: string | null
			channels?: readonly string[] | string | null
		}>
	>
	/** Automatic and manual till rules. No coupon codes. Absent on an older catalog. */
	discountRules?: unknown
	/**
	 * When `discountRules` were last fetched from the server (epoch ms). A failed
	 * refresh keeps the older rules and their older stamp; the till stops
	 * applying them after `TILL_RULES_MAX_AGE_MS`. Absent on a catalog stored
	 * before the stamp existed (the catalog's own `fetchedAt` stands in).
	 */
	discountRulesAt?: number
}

/** Published branding (`GET /resources/sites`). */
export type PublicSiteTheme = {
	baseColor: string
	theme: string
	radius: string
	mode: 'light' | 'dark' | 'system'
	headingFont?: string
	bodyFont?: string
	headingCustomFont?: { url: string; format: string } | null
	bodyCustomFont?: { url: string; format: string } | null
	css: string
}

export type PublicOrganization = {
	id: string
	name: string
	slug: string
	dataRegion?: string | null
	theme?: PublicSiteTheme
	siteIcon?: { original: string; appleTouchIcon: string } | null
}

/** A catalog snapshot as stored on the device. */
export type CatalogSnapshot = {
	key: 'catalog'
	fetchedAt: number
	organization: PublicOrganization
	menu: MenuPayload
}
