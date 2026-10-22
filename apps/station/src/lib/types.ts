/**
 * Shapes of the published catalog the POS reads from the App
 * (`GET /resources/sites/menu`). Mirrors apps/sites/src/lib/org.ts; the POS only
 * declares the fields it uses. Prices arrive in major currency units and are
 * converted to integer cents at the edge (see `toCents`).
 */

export type SelectionType = 'single' | 'multiple' | 'quantity' | 'pizza'

export type MenuOption = {
	id: string
	displayName: string
	price: number
	minSelections: number
	maxSelections: number | null
	isDefault: boolean
	applySalesTax: boolean
	availabilityStatus: string
	position: number
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
}

export type MenuItem = {
	id: string
	displayName: string
	description: string | null
	price: number
	imageUrl: string | null
	variations: { groups: VariationGroup[]; variants: Variant[] }
	isVegetarian: boolean
	isGlutenFree: boolean
	isAlcohol: boolean
	allergens: string[]
	isPopular: boolean
	availabilityStatus: string
	position: number
	modifierGroups: ModifierGroup[]
}

export type MenuCategory = {
	id: string
	displayName: string
	parentId?: string | null
	subcategories?: MenuCategory[]
	availabilityStatus: string
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
		position: number
		categories: MenuCategory[]
	}>
	locationOverrides: Record<
		string,
		Array<{
			entityType: string
			entityId: string
			isEnabled?: boolean | null
			price?: number | null
			availabilityStatus?: string | null
		}>
	>
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
