export type Half = 'whole' | 'left' | 'right'

export type SelectionType = 'single' | 'multiple' | 'quantity' | 'pizza'

export type FulfillmentMode = 'pickup' | 'delivery'

export type ModifierOption = {
	id: string
	displayName: string
	description?: string | null
	imageUrl?: string | null
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	calories?: number | null
	minSelections?: number
	maxSelections?: number | null
	isDefault?: boolean
	availabilityStatus?: string
	nestedModifierGroups?: ModifierGroup[]
}

export type ModifierGroup = {
	id: string
	name: string
	selectionType: SelectionType
	minSelections: number
	maxSelections: number | null
	availabilityStatus?: string
	options: ModifierOption[]
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
	imageUrl?: string | null
	availabilityStatus: 'available' | 'unavailable' | string
}

export type OrderingItem = {
	id: string
	displayName: string
	description?: string | null
	price: number
	imageUrl?: string | null
	variations: {
		groups: VariationGroup[]
		variants: Variant[]
	}
	modifierGroups: ModifierGroup[]
	isVegetarian?: boolean
	isGlutenFree?: boolean
	isAlcohol?: boolean
	allergens?: string[]
	calorieMin?: number | null
	calorieMax?: number | null
	isPopular?: boolean
	availabilityStatus?: string
	/** `false` when the owning menu disables the special instructions field. */
	specialInstructions?: boolean
}

export type OrderingCategory = {
	id: string
	displayName: string
	description?: string | null
	items: OrderingItem[]
	subcategories?: OrderingCategory[]
}

export type CartOption = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	/** Price contribution of this option line (already multiplied by `quantity`). */
	priceDelta: number
	half?: Half
	quantity?: number
	/**
	 * Display-only echo of a size/variant choice. The order API prices variants
	 * from `variantId`, so these are never sent as modifier options.
	 */
	variation?: boolean
}

export type CartLine = {
	itemId: string
	quantity: number
}

/**
 * Persisted cart line. Shape is read by `pages/menu/checkout.astro`; keep the
 * field names stable.
 */
export type CartItem = CartLine & {
	id: string
	variantId?: string
	name: string
	basePrice: number
	unitPrice: number
	options: CartOption[]
	instructions: string
}

export type ConstraintRule = {
	inventory?: number | null
	maxPerOrder?: number | null
}

export type Constraints = {
	items?: Record<string, ConstraintRule>
	categories?: Record<string, ConstraintRule & { name?: string }>
	/** Item id to every category id (including ancestors) it is listed under. */
	itemCategoryIds?: Record<string, string[]>
	/** When false, counts stay hidden but caps and "Sold out" still apply. */
	showInventory?: boolean
}

export type RemainingReason = 'inventory' | 'limit' | 'category-inventory'

export type Remaining = {
	/** Maximum additional quantity that can still be added; `null` means uncapped. */
	max: number | null
	reason: RemainingReason | null
	/** Remaining stock for the item itself when inventory is tracked. */
	remaining?: number
	categoryName?: string
	/** The per-order limit that produced a `limit` reason. */
	limit?: number
}

export type PickupSelection = {
	locationId: string
	date: string
	slotStart: string
	slotEnd: string
}

export type OrderingLabels = {
	addToOrder: string
	soldOut: string
	from: string
	required: string
	optional: string
	done: string
	chooseOne: string
	chooseN: string
	chooseAtLeastN: string
	chooseRange: string
	upToN: string
	chooseAtLeastOne: string
	chooseAtLeastNOptions: string
	combinationUnavailable: string
	whole: string
	left: string
	right: string
	none: string
	quantity: string
	increase: string
	decrease: string
	remove: string
	onlyNLeft: string
	onlyNLeftIn: string
	limitNPerOrder: string
	limitReached: string
	emptyCartTitle: string
	emptyCartDesc: string
	closeDialog: string
	customizeItem: string
	itemsCount: string
}
