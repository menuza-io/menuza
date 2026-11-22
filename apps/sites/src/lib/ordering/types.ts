import { type FocalPoint } from '@repo/common/image-focal'

export type Half = 'whole' | 'left' | 'right'

export type SelectionType = 'single' | 'multiple' | 'quantity' | 'pizza'

export type FulfillmentMode = 'pickup' | 'delivery'

export type ModifierOption = {
	id: string
	displayName: string
	description?: string | null
	imageUrl?: string | null
	/** Focal point of the photo (#394); missing or null is the centre crop. */
	imageFocal?: FocalPoint | null
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	calories?: number | null
	minSelections?: number
	maxSelections?: number | null
	isDefault?: boolean
	availabilityStatus?: string
	/**
	 * Daily limit (#409): how many are left today, set only while the
	 * restaurant lets guests see "Only N left".
	 */
	dailyRemaining?: number | null
	/** The availability the menu published, kept while a daily sell-out overrides it. */
	publishedAvailability?: string
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
	imageFocal?: FocalPoint | null
	excludeFromDiscounts?: boolean
	availabilityStatus: 'available' | 'unavailable' | string
}

export type OrderingItem = {
	id: string
	displayName: string
	description?: string | null
	price: number
	imageUrl?: string | null
	/** Focal point of the primary photo (#394). */
	imageFocal?: FocalPoint | null
	/** A running photo test (#192): `imageUrl` is always photo A. */
	photoTest?: {
		id: string
		imageUrlB: string
		imageFocalB: FocalPoint | null
		key?: string
	} | null
	variations: {
		groups: VariationGroup[]
		variants: Variant[]
	}
	modifierGroups: ModifierGroup[]
	isVegetarian?: boolean
	isGlutenFree?: boolean
	isAlcohol?: boolean
	/** Dietary tags (#335), unknown values already dropped. */
	dietaryTags?: string[]
	allergens?: string[]
	calorieMin?: number | null
	calorieMax?: number | null
	isPopular?: boolean
	/** The restaurant suggests this dish next to an order (#114). */
	isUpsell?: boolean
	excludeFromDiscounts?: boolean
	availabilityStatus?: string
	channels?: readonly string[] | string | null
	/** Daily limit (#409): how many are left today, when guests may see it. */
	dailyRemaining?: number | null
	/** The availability the menu published, kept while a daily sell-out overrides it. */
	publishedAvailability?: string
	/** `false` when the owning menu disables the special instructions field. */
	specialInstructions?: boolean
}

export type OrderingCategory = {
	id: string
	displayName: string
	description?: string | null
	/** Categories whose dishes go well with this one (#114). */
	upsellCategoryIds?: string[]
	channels?: readonly string[] | string | null
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
	/**
	 * The photo test (#192) this dish was in when it was added. Checkout reads
	 * it to tell the region which photo this browser showed; carts saved
	 * before it existed simply have none.
	 */
	photoTestId?: string
	/** The beacon key of that test; a cart saved before it has none (no add counted). */
	photoTestKey?: string
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
	/** Screen-reader words before the struck regular price and the sale price. */
	originalPrice: string
	salePrice: string
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
	/** Drawer row for the discounts the region priced. */
	discounts: string
	/** The estimate has no discounts yet (a quote is on its way or failed). */
	beforeDiscounts: string
	/** Delivery order with no verified address: the region cannot price yet. */
	discountsAtCheckout: string
	/** "Code {code} could not be applied." */
	couponNotApplied?: string
	/** "Remove" (the note's dismiss button text). */
	couponRemove?: string
	/** "Remove code {code}" (the note's dismiss button name). */
	couponNoteRemove?: string
	/** "Code {code} is saved…" after a printed coupon's QR opened the menu. */
	couponSaved?: string
	/** Empty-cart action in the drawer; closes it so the guest keeps browsing. */
	exploreMenu?: string
	/** "Goes well with": the heading of the cart suggestions (#114). */
	upsellHeading?: string
	/** "Add": the button on a suggested dish. */
	upsellAdd?: string
	/** "Add {name}": that button's accessible name. */
	upsellAddNamed?: string
}
