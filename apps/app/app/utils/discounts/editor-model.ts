import {
	DISCOUNT_CODE_PATTERN,
	DISCOUNT_DESCRIPTION_MAX,
	combinesWithOf,
	DISCOUNT_MAX_BUNDLE_SLOTS,
	DISCOUNT_MAX_BUNDLE_UNITS,
	DISCOUNT_MAX_SCHEDULE_WINDOWS,
	DISCOUNT_MAX_TARGET_CATEGORIES,
	DISCOUNT_MAX_TARGET_ITEMS,
	DISCOUNT_MAX_TARGET_MODIFIER_GROUPS,
	DISCOUNT_MAX_TARGET_MODIFIER_OPTIONS,
	DISCOUNT_MAX_TIER_STEPS,
	DISCOUNT_MAX_UNITS,
	DISCOUNT_MAX_VARIANT_GROUPS,
	DISCOUNT_MAX_VARIANT_VALUES,
	DISCOUNT_NAME_MAX,
	DISCOUNT_TOTAL_LIMIT_PRESETS,
	type DiscountApplication,
	type DiscountChannel,
	type DiscountCombineClass,
	type DiscountBuySet,
	type DiscountDefinition,
	discountDefinitionSchema,
	type DiscountItemSet,
	type DiscountEligibility,
	type DiscountFulfillment,
	type DiscountLimitPeriod,
	type DiscountStatus,
	type DiscountTierBasis,
	type DiscountValueType,
	normalizeDiscountCode,
	type DiscountVariantFilter,
	variantKey,
} from '@repo/discounts'
import { type LoyaltyCatalogOption } from '#app/utils/loyalty/catalog.ts'
import {
	bpToPercentInput,
	minorToMoneyInput,
	parsePercentToBp,
} from '#app/utils/loyalty/loyalty-view.ts'
import {
	currencyExponent,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'
import {
	cleanLocalizedMap,
	defaultEntry,
	type LocalesLike,
	type LocalizedMap,
} from '#app/utils/reservations/localized.ts'

/**
 * The discount editor's form state and its conversion to and from the stored
 * definition. Pure, so it is shared by the editor, the live preview and the
 * server action. Errors are codes keyed by field; the UI words them.
 */

export type ScheduleRow = { day: number; start: string; end: string }

export type CodeRow = {
	/** Stable React key. */
	key: string
	/** The stored code's id, when it already exists. */
	id: string | null
	code: string
	maxUses: string
}

/**
 * One row of an "only these options" filter: an option type ("size") and the
 * values of it that qualify ("large", "medium"). Both are keys, the menu name
 * lower-cased (`variantKey`). A row still being filled in may have an empty
 * group or no values; the save drops it.
 */
export type VariantFilterRow = { group: string; values: string[] }

/** A group of items or categories and how many of them the deal takes. */
export type ItemGroupState = {
	quantity: string
	itemIds: string[]
	categoryIds: string[]
	/** Options the group is limited to ("Size: Large"); empty means any. */
	variants: VariantFilterRow[]
	/** The buy group only: count the items, or add up what is spent on them. */
	by: 'quantity' | 'spend'
	spend: string
}

/** One step of a ladder: what must be reached, and what it earns. */
export type TierRow = {
	/** Stable React key. */
	key: string
	/** An amount or an item count, as typed. */
	at: string
	/** A percentage or an amount, as typed, by the discount's value type. */
	value: string
}

/** One group of a meal deal. The key keeps a row's identity while it is edited. */
export type SlotState = ItemGroupState & { key: string }

/**
 * An option type the menu uses ("Size"), with every value of it across the
 * items. `key` and each value's `id` are what a discount stores; `name` is
 * shown, in the website's default language.
 */
export type DiscountVariantGroupChoice = {
	key: string
	name: string
	/** How many items use this option type. */
	items: number
	values: LoyaltyCatalogOption[]
}

/**
 * Choices beyond items and categories the editor can pick by name: modifier
 * groups and options, and the option types (variations) items share.
 */
export type DiscountChoiceCatalog = {
	groups: LoyaltyCatalogOption[]
	options: LoyaltyCatalogOption[]
	variantGroups: DiscountVariantGroupChoice[]
}

export type TotalLimitChoice =
	'unlimited' | `${(typeof DISCOUNT_TOTAL_LIMIT_PRESETS)[number]}` | 'custom'

export type EditorState = {
	/** The guest-facing name in each website language (language → text). */
	name: LocalizedMap
	/** Operator-only, so one plain text. */
	internalName: string
	/** The guest-facing description in each website language. */
	description: LocalizedMap
	application: DiscountApplication
	valueType: DiscountValueType
	percent: string
	amount: string
	maxDiscount: string
	/** A ladder in place of one value: spend or buy more, save more. */
	tiersOn: boolean
	tierBasis: DiscountTierBasis
	tiers: TierRow[]
	/** Free delivery only: the largest delivery fee it waives. */
	maxDeliveryFee: string
	scope: 'order' | 'items' | 'categories' | 'modifiers'
	/** Modifier groups and options a modifier discount covers. */
	modifierGroupIds: string[]
	modifierOptionIds: string[]
	/** Options the discount is limited to (items, categories, modifiers). */
	variants: VariantFilterRow[]
	itemIds: string[]
	categoryIds: string[]
	excludeItemIds: string[]
	excludeCategoryIds: string[]
	requireOn: boolean
	requireQuantity: string
	requireItemIds: string[]
	requireCategoryIds: string[]
	quantityKind:
		'none' | 'exact' | 'minimum' | 'bogo' | 'buy_get' | 'bundle' | 'per_item'
	/** Choices discounted on each item (`per_item`). */
	perItemN: string
	/** Buy from one group, get from another (`buy_get`). */
	buyGroup: ItemGroupState
	getGroup: ItemGroupState
	/** The parts of a meal deal (`bundle`). */
	bundleSlots: SlotState[]
	quantityN: string
	buyQuantity: string
	getQuantity: string
	maxUnits: string
	minSubtotal: string
	allLocations: boolean
	locationIds: string[]
	channels: DiscountChannel[]
	fulfillments: DiscountFulfillment[]
	includeDrops: boolean
	startsAt: string
	endsAt: string
	hoursOn: boolean
	schedule: ScheduleRow[]
	eligibility: DiscountEligibility
	totalLimit: TotalLimitChoice
	totalLimitCustom: string
	perCustomerOn: boolean
	perCustomerCount: string
	perCustomerPeriod: DiscountLimitPeriod
	codes: CodeRow[]
	/** The kinds of discount this one may stack with. */
	combinesWith: DiscountCombineClass[]
	priority: string
	promoteOnMenu: boolean
	requireApproval: boolean
}

/** A whole number that has to fall between two limits: `range:1:1000`. */
export type RangeCode = `range:${number}:${number}`

export function rangeCode(min: number, max: number): RangeCode {
	return `range:${min}:${max}`
}

export function parseRangeCode(
	code: string,
): { min: number; max: number } | null {
	const match = /^range:(\d+):(\d+)$/.exec(code)
	return match ? { min: Number(match[1]), max: Number(match[2]) } : null
}

export type EditorErrorCode =
	| RangeCode
	| 'required'
	| 'default_language_required'
	| 'too_long'
	| 'percent'
	| 'amount'
	| 'number'
	| 'choose_items'
	| 'choose_categories'
	| 'choose_one'
	| 'date'
	| 'end_before_start'
	| 'time'
	| 'same_time'
	| 'add_hours'
	| 'code_format'
	| 'code_duplicate'
	| 'code_taken'
	| 'too_many_codes'
	| 'org_codes_limit'
	| 'amounts_unavailable'
	| 'limits_unavailable'
	| 'mixed_currencies'
	| 'needs_delivery'
	| 'bundle_too_big'
	| 'choose_modifiers'
	| 'add_tier'
	| 'tiers_ascending'
	| 'set_price_needs_items'
	| 'set_price_quantity'
	| 'bogo_needs_items'
	| 'too_many_windows'
	| 'too_many_items'
	| 'too_many_categories'
	| 'too_many_modifiers'
	| 'too_many_variants'
	| 'application_off'
	| 'location_scope'
	| 'invalid'

/**
 * Most codes one discount keeps. Region lookups bind one parameter per code
 * and D1 and Durable Object SQLite allow 100 per statement.
 */
export const DISCOUNT_MAX_CODES = 90

export type EditorErrors = Record<string, EditorErrorCode>

/**
 * Orders price in hundredths (`dollarsToCents` in `@repo/common`, and Sites
 * divides by 100), so an amount counted in a currency with another number of
 * decimals (KWD has 3, JPY has 0) would be read as the wrong sum. Until orders
 * count in the currency's own minor unit, money in those currencies is refused
 * and percentages still work.
 */
export const SUPPORTED_AMOUNT_EXPONENT = 2

export function amountsSupported(currency: string): boolean {
	return currencyExponent(currency) === SUPPORTED_AMOUNT_EXPONENT
}

/** A location as the editor needs it: its name and the currency its orders use. */
export type DiscountLocationChoice = {
	id: string
	name: string
	currency: string
	/** An inactive location takes no orders; "all locations" leaves it out. */
	active: boolean
}

export type DiscountCurrencyResolution =
	{ mixed: false; currency: string } | { mixed: true; currency: null }

/**
 * The currency a discount's amounts are in. Orders price in the currency of
 * the location they are placed at, and the engine never converts, so the
 * amounts follow the locations the discount applies to (every active location
 * for "all locations"). One shared currency is used as it is; a mix means the
 * operator has to narrow the locations before any amount can be set.
 * `fallback` serves an organization with no locations to read a currency from.
 */
export function resolveDiscountCurrency(
	state: Pick<EditorState, 'allLocations' | 'locationIds'>,
	locations: ReadonlyArray<
		Pick<DiscountLocationChoice, 'id' | 'currency'> & {
			active?: boolean
		}
	>,
	fallback: string,
): DiscountCurrencyResolution {
	const chosen = new Set(state.locationIds)
	const covered = state.allLocations
		? locations.filter((location) => location.active !== false)
		: locations.filter((location) => chosen.has(location.id))
	const currencies = new Set(covered.map((location) => location.currency))
	if (currencies.size > 1) return { mixed: true, currency: null }
	return { mixed: false, currency: [...currencies][0] ?? fallback }
}

/**
 * Whether the discount holds an amount of money: a fixed value, a cap, a
 * minimum spend, a spend ladder, a spend-based deal or a delivery-fee limit.
 * A percentage with none of those has no currency.
 */
export function stateUsesAmounts(state: EditorState): boolean {
	if (
		state.valueType === 'fixed' ||
		state.valueType === 'fixed_price' ||
		state.valueType === 'variable_amount'
	) {
		return true
	}
	if (state.minSubtotal.trim()) return true
	if (
		(state.valueType === 'percent' || state.valueType === 'variable_percent') &&
		state.maxDiscount.trim()
	) {
		return true
	}
	if (state.valueType === 'free_delivery' && state.maxDeliveryFee.trim()) {
		return true
	}
	if (tiersApply(state) && state.tierBasis === 'spend') return true
	return state.quantityKind === 'buy_get' && state.buyGroup.by === 'spend'
}

/**
 * The channels the editor offers. A stored discount may still name one that
 * no longer takes orders (the customer app orders through the website); the
 * form says so, and saving drops it (`unsupportedChannels`).
 */
export const ALL_CHANNELS = [
	'web',
	'qr',
	'pos',
] as const satisfies readonly DiscountChannel[]

export type EditorChannel = (typeof ALL_CHANNELS)[number]

export function isEditorChannel(value: string): value is EditorChannel {
	return (ALL_CHANNELS as readonly string[]).includes(value)
}

/** Channels the stored discount names that the editor no longer offers. */
export function unsupportedChannels(
	channels: readonly DiscountChannel[],
): DiscountChannel[] {
	return channels.filter((channel) => !isEditorChannel(channel))
}
export const ALL_FULFILLMENTS: readonly DiscountFulfillment[] = [
	'pickup',
	'delivery',
	'dine_in',
]

let keyCounter = 0
export function newCodeKey(): string {
	keyCounter += 1
	return `code-${keyCounter}`
}

export { DISCOUNT_MAX_BUNDLE_SLOTS, DISCOUNT_MAX_BUNDLE_UNITS }

export function emptyGroup(quantity = '1'): ItemGroupState {
	return {
		quantity,
		itemIds: [],
		categoryIds: [],
		variants: [],
		by: 'quantity',
		spend: '',
	}
}

export function newTier(at = '', value = ''): TierRow {
	keyCounter += 1
	return { key: `tier-${keyCounter}`, at, value }
}

export { DISCOUNT_MAX_TIER_STEPS }

/**
 * A ladder fits a plain item or order discount that sets a percentage or an
 * amount: not a till discount, a counted rule, a deal or a modifier discount.
 * The editor hides the ladder, and the save ignores it, when it doesn't fit.
 */
export function tiersApply(
	state: Pick<
		EditorState,
		'tiersOn' | 'valueType' | 'application' | 'scope' | 'quantityKind'
	>,
): boolean {
	return (
		state.tiersOn &&
		(state.valueType === 'percent' || state.valueType === 'fixed') &&
		state.application !== 'manual' &&
		state.scope !== 'modifiers' &&
		state.quantityKind === 'none'
	)
}

/**
 * Promote on menu shows the offer to every visitor, and the menu can't say who
 * qualifies. So only a discount everyone can use is promoted: one for signed-in
 * customers, new customers or loyalty members would be a promise most visitors
 * are then refused. A manager approval at the till has no effect online, so it
 * does not stop a promotion.
 */
export function promoteOnMenuAllowed(
	state: Pick<EditorState, 'eligibility'>,
): boolean {
	return state.eligibility === 'everyone'
}

export function newSlot(quantity = '1'): SlotState {
	keyCounter += 1
	return { ...emptyGroup(quantity), key: `slot-${keyCounter}` }
}

function groupFromRule(
	set: {
		quantity?: number
		spendMinor?: number
		itemIds: readonly string[]
		categoryIds: readonly string[]
		variants?: readonly DiscountVariantFilter[]
	},
	currency: string,
): ItemGroupState {
	return {
		quantity: String(set.quantity ?? 1),
		itemIds: [...set.itemIds],
		categoryIds: [...set.categoryIds],
		variants: variantRowsOf(set.variants),
		by: set.spendMinor !== undefined ? 'spend' : 'quantity',
		spend:
			set.spendMinor !== undefined
				? minorToMoneyInput(set.spendMinor, currency)
				: '',
	}
}

export function emptyEditorState(
	application: DiscountApplication = 'automatic',
): EditorState {
	return {
		name: {},
		internalName: '',
		description: {},
		application,
		valueType: 'percent',
		percent: '',
		amount: '',
		maxDiscount: '',
		tiersOn: false,
		tierBasis: 'spend',
		tiers: [newTier(), newTier()],
		maxDeliveryFee: '',
		scope: 'order',
		modifierGroupIds: [],
		modifierOptionIds: [],
		variants: [],
		itemIds: [],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
		requireOn: false,
		requireQuantity: '1',
		requireItemIds: [],
		requireCategoryIds: [],
		quantityKind: 'none',
		buyGroup: emptyGroup(),
		getGroup: emptyGroup(),
		bundleSlots: [newSlot(), newSlot()],
		quantityN: '2',
		perItemN: '2',
		buyQuantity: '1',
		getQuantity: '1',
		maxUnits: '',
		minSubtotal: '',
		allLocations: true,
		locationIds: [],
		channels: [...ALL_CHANNELS],
		fulfillments: [...ALL_FULFILLMENTS],
		includeDrops: false,
		startsAt: '',
		endsAt: '',
		hoursOn: false,
		schedule: [],
		eligibility: 'everyone',
		totalLimit: 'unlimited',
		totalLimitCustom: '',
		perCustomerOn: false,
		perCustomerCount: '1',
		perCustomerPeriod: 'lifetime',
		codes: [],
		combinesWith: [],
		priority: '0',
		promoteOnMenu: false,
		requireApproval: false,
	}
}

export type StoredCode = {
	id: string
	code: string
	maxUses: number | null
}

/** Stored variant filters as editor rows (copies, so edits never alias). */
function variantRowsOf(
	filters: readonly DiscountVariantFilter[] | undefined,
): VariantFilterRow[] {
	return (filters ?? []).map((filter) => ({
		group: filter.group,
		values: [...filter.values],
	}))
}

/**
 * The filters a save stores: rows without an option type or without values
 * are dropped, keys are normalized and each value is kept once.
 */
export function cleanVariantRows(
	rows: readonly VariantFilterRow[],
): DiscountVariantFilter[] {
	return rows.flatMap((row) => {
		const group = variantKey(row.group)
		const values = [
			...new Set(row.values.map(variantKey).filter((value) => value)),
		]
		return group && values.length > 0 ? [{ group, values }] : []
	})
}

/**
 * A stored language map as the editor's, with the canonical text as the
 * default-language entry when the map lacks one (a discount saved before the
 * default language changed, or a copy).
 */
function localizedState(
	map: Readonly<Record<string, string>> | undefined,
	canonical: string | null,
	defaultLocale: string,
): LocalizedMap {
	const out: LocalizedMap = { ...map }
	if (!out[defaultLocale]?.trim() && canonical) out[defaultLocale] = canonical
	return out
}

export function stateFromDefinition(
	definition: DiscountDefinition,
	codes: readonly StoredCode[],
	currency: string,
	/** The website's default language: the canonical name is its entry. */
	locales: Pick<LocalesLike, 'defaultLocale'>,
): EditorState {
	const base = emptyEditorState(definition.application)
	const rule = definition.quantityRule
	const preset = DISCOUNT_TOTAL_LIMIT_PRESETS.find(
		(value) => value === definition.totalLimit,
	)
	return {
		...base,
		name: localizedState(
			definition.nameI18n,
			definition.name,
			locales.defaultLocale,
		),
		internalName: definition.internalName ?? '',
		description: localizedState(
			definition.descriptionI18n,
			definition.description,
			locales.defaultLocale,
		),
		valueType: definition.valueType,
		percent: bpToPercentInput(definition.percentBp),
		amount: minorToMoneyInput(definition.amountMinor, currency),
		maxDiscount: minorToMoneyInput(definition.maxDiscountMinor, currency),
		tiersOn: Boolean(definition.tiers),
		tierBasis: definition.tiers?.basis ?? 'spend',
		tiers: definition.tiers
			? definition.tiers.steps.map((step) =>
					newTier(
						definition.tiers!.basis === 'spend'
							? minorToMoneyInput(step.at, currency)
							: String(step.at),
						step.percentBp !== null
							? bpToPercentInput(step.percentBp)
							: minorToMoneyInput(step.amountMinor, currency),
					),
				)
			: base.tiers,
		maxDeliveryFee: minorToMoneyInput(
			definition.maxDeliveryFeeMinor ?? null,
			currency,
		),
		scope: definition.target.scope,
		modifierGroupIds: [...(definition.target.modifierGroupIds ?? [])],
		modifierOptionIds: [...(definition.target.modifierOptionIds ?? [])],
		variants: variantRowsOf(definition.target.variants),
		itemIds: [...definition.target.itemIds],
		categoryIds: [...definition.target.categoryIds],
		excludeItemIds: [...definition.target.excludeItemIds],
		excludeCategoryIds: [...definition.target.excludeCategoryIds],
		requireOn: definition.requirement !== null,
		requireQuantity: String(definition.requirement?.quantity ?? 1),
		requireItemIds: [...(definition.requirement?.itemIds ?? [])],
		requireCategoryIds: [...(definition.requirement?.categoryIds ?? [])],
		quantityKind: rule.kind,
		buyGroup:
			rule.kind === 'buy_get'
				? groupFromRule(rule.buy, currency)
				: emptyGroup(),
		getGroup:
			rule.kind === 'buy_get'
				? groupFromRule(rule.get, currency)
				: emptyGroup(),
		bundleSlots:
			rule.kind === 'bundle'
				? rule.slots.map((slot) => ({
						...groupFromRule(slot, currency),
						key: newSlot().key,
					}))
				: base.bundleSlots,
		quantityN:
			rule.kind === 'exact' || rule.kind === 'minimum'
				? String(rule.quantity)
				: base.quantityN,
		perItemN: rule.kind === 'per_item' ? String(rule.quantity) : '2',
		buyQuantity: rule.kind === 'bogo' ? String(rule.buyQuantity) : '1',
		getQuantity: rule.kind === 'bogo' ? String(rule.getQuantity) : '1',
		maxUnits:
			definition.maxDiscountedUnits === null
				? ''
				: String(definition.maxDiscountedUnits),
		minSubtotal: minorToMoneyInput(definition.minSubtotalMinor, currency),
		allLocations: definition.locationIds === null,
		locationIds: [...(definition.locationIds ?? [])],
		channels: [...definition.channels],
		fulfillments: [...definition.fulfillments],
		includeDrops: definition.includeDrops,
		startsAt: definition.startsAt ?? '',
		endsAt: definition.endsAt ?? '',
		hoursOn: definition.schedule !== null,
		schedule: (definition.schedule ?? []).map((window) => ({ ...window })),
		eligibility: definition.eligibility,
		totalLimit:
			definition.totalLimit === null
				? 'unlimited'
				: preset !== undefined
					? (String(preset) as TotalLimitChoice)
					: 'custom',
		totalLimitCustom:
			definition.totalLimit !== null && preset === undefined
				? String(definition.totalLimit)
				: '',
		perCustomerOn: definition.perCustomerLimit !== null,
		perCustomerCount: String(definition.perCustomerLimit?.count ?? 1),
		perCustomerPeriod: definition.perCustomerLimit?.period ?? 'lifetime',
		codes: codes.map((code) => ({
			key: newCodeKey(),
			id: code.id,
			code: code.code,
			maxUses: code.maxUses === null ? '' : String(code.maxUses),
		})),
		combinesWith: [...combinesWithOf(definition)],
		priority: String(definition.priority),
		promoteOnMenu: definition.promoteOnMenu,
		requireApproval: definition.requireApproval,
	}
}

export type CodeInput = {
	id: string | null
	code: string
	maxUses: number | null
}

export type EditorResult =
	| { ok: true; definition: DiscountDefinition; codes: CodeInput[] }
	| { ok: false; errors: EditorErrors }

/** Schema issue paths to the editor field ids that show them. */
const PATH_TO_FIELD: Record<string, string> = {
	name: 'name',
	nameI18n: 'name',
	internalName: 'internalName',
	description: 'description',
	descriptionI18n: 'description',
	percentBp: 'percent',
	amountMinor: 'amount',
	currency: 'amount',
	maxDiscountMinor: 'maxDiscount',
	target: 'target',
	requirement: 'requirement',
	quantityRule: 'quantityKind',
	maxDiscountedUnits: 'maxUnits',
	minSubtotalMinor: 'minSubtotal',
	locationIds: 'locations',
	channels: 'channels',
	fulfillments: 'fulfillments',
	schedule: 'schedule',
	startsAt: 'startsAt',
	endsAt: 'endsAt',
	totalLimit: 'totalLimit',
	perCustomerLimit: 'perCustomerCount',
	priority: 'priority',
	valueType: 'valueType',
	tiers: 'tiers',
	combinesWith: 'combinesWith',
	maxDeliveryFeeMinor: 'maxDeliveryFee',
}

/**
 * The schema asks for a currency whenever an amount of money is stored. Show
 * that issue on a field the form renders for this discount, so the operator
 * never sees an error with no field.
 */
export function currencyIssueField(
	state: Pick<EditorState, 'valueType' | 'quantityKind' | 'buyGroup'>,
	has: {
		maxDiscount: boolean
		minSubtotal: boolean
		maxDeliveryFee: boolean
		tiers: boolean
	},
): string {
	if (has.maxDiscount) return 'maxDiscount'
	if (has.minSubtotal) return 'minSubtotal'
	if (has.maxDeliveryFee) return 'maxDeliveryFee'
	if (has.tiers) return 'tiers'
	if (state.quantityKind === 'buy_get' && state.buyGroup.by === 'spend') {
		return 'buyGroup.spend'
	}
	if (state.valueType === 'fixed' || state.valueType === 'fixed_price') {
		return 'amount'
	}
	return 'valueType'
}

/** Where a server-side schema issue shows up in the editor. */
export function fieldForIssuePath(path: readonly PropertyKey[]): string {
	const head = String(path[0] ?? '')
	return PATH_TO_FIELD[head] ?? 'form'
}

export function stateToDefinition(
	state: EditorState,
	options: {
		/**
		 * The currency of the chosen locations (`resolveDiscountCurrency`), or
		 * `null` when they use several: amounts of money are then refused.
		 */
		currency: string | null
		status: DiscountStatus
		/**
		 * The website's languages. The name and description keep only these,
		 * and the default language's entry is the canonical text.
		 */
		locales: LocalesLike
		/** Existing codes' normalized values owned by other discounts, if known. */
		takenCodes?: ReadonlySet<string>
		features?: { automatic: boolean; coupons: boolean }
	},
): EditorResult {
	const errors: EditorErrors = {}
	const mixedCurrencies = options.currency === null
	// Amounts are read in a stand-in until the check for mixed currencies below.
	const currency = options.currency ?? 'USD'
	const fail = (field: string, code: EditorErrorCode) => {
		errors[field] ??= code
	}
	const noAmounts = !amountsSupported(currency)
	// A money condition or cap typed in a currency orders can't count yet.
	const moneyField = (text: string, field: string): number | null => {
		if (noAmounts) {
			fail(field, 'limits_unavailable')
			return null
		}
		const minor = parseMoneyToMinor(text, { currency, min: 1 })
		if (minor === null) fail(field, 'amount')
		return minor
	}

	// Guest-facing text in the website's languages; the default language's
	// entry is the canonical name and description.
	const nameI18n = cleanLocalizedMap(state.name, options.locales)
	const descriptionI18n = cleanLocalizedMap(state.description, options.locales)
	const name = defaultEntry(nameI18n, options.locales)
	if (!name) {
		fail(
			'name',
			Object.keys(nameI18n).length > 0
				? 'default_language_required'
				: 'required',
		)
	} else if (
		Object.values(nameI18n).some((text) => text.length > DISCOUNT_NAME_MAX)
	) {
		fail('name', 'too_long')
	}
	if (state.internalName.trim().length > DISCOUNT_NAME_MAX) {
		fail('internalName', 'too_long')
	}
	if (
		Object.values(descriptionI18n).some(
			(text) => text.length > DISCOUNT_DESCRIPTION_MAX,
		)
	) {
		fail('description', 'too_long')
	}
	const description = defaultEntry(descriptionI18n, options.locales) || null

	let percentBp: number | null = null
	let amountMinor: number | null = null
	let maxDiscountMinor: number | null = null
	const cap = () => {
		if (!state.maxDiscount.trim()) return
		maxDiscountMinor = moneyField(state.maxDiscount, 'maxDiscount')
	}
	// With a ladder each tier carries its own value, so the single one is not read.
	const tiered = tiersApply(state)
	if (
		noAmounts &&
		(state.valueType === 'fixed' ||
			state.valueType === 'fixed_price' ||
			state.valueType === 'variable_amount')
	) {
		fail('valueType', 'amounts_unavailable')
	}
	if (state.valueType === 'percent') {
		if (!tiered) {
			percentBp = parsePercentToBp(state.percent)
			if (percentBp === null) fail('percent', 'percent')
		}
		cap()
	} else if (state.valueType === 'variable_percent') {
		if (state.application !== 'manual') fail('valueType', 'invalid')
		cap()
	} else if (state.valueType === 'fixed' || state.valueType === 'fixed_price') {
		if (!noAmounts && (!tiered || state.valueType === 'fixed_price')) {
			amountMinor = parseMoneyToMinor(state.amount, { currency, min: 1 })
			if (amountMinor === null) fail('amount', 'amount')
		}
	} else if (state.valueType === 'variable_amount') {
		if (state.application !== 'manual') fail('valueType', 'invalid')
		cap()
	}

	let minSubtotalMinor: number | null = null
	if (state.minSubtotal.trim()) {
		minSubtotalMinor = moneyField(state.minSubtotal, 'minSubtotal')
	}

	let maxDeliveryFeeMinor: number | null = null
	if (state.valueType === 'free_delivery' && state.maxDeliveryFee.trim()) {
		maxDeliveryFeeMinor = moneyField(state.maxDeliveryFee, 'maxDeliveryFee')
	}

	const whole = (text: string, field: string, min = 1, max = 1000) => {
		const value = parseWholeNumber(text, { min, max })
		if (value === null) fail(field, rangeCode(min, max))
		return value
	}

	const freeDelivery = state.valueType === 'free_delivery'
	// These two rules name their own items, so the target is the whole order.
	const setRule =
		!freeDelivery &&
		(state.quantityKind === 'buy_get' || state.quantityKind === 'bundle')
	const scope = freeDelivery || setRule ? 'order' : state.scope
	// A modifier discount discounts every matching choice or the first few on
	// each item; the counted rules belong to item discounts.
	const kind =
		scope === 'modifiers'
			? state.quantityKind === 'per_item'
				? 'per_item'
				: 'none'
			: state.quantityKind === 'per_item'
				? 'none'
				: state.quantityKind
	if (
		state.application === 'manual' &&
		(setRule || state.valueType === 'fixed_price')
	) {
		fail('application', 'invalid')
	}
	if (state.valueType === 'fixed_price' && !setRule) {
		if (scope === 'order') fail('target', 'set_price_needs_items')
		if (kind !== 'none' && kind !== 'per_item') {
			fail('quantityKind', 'set_price_quantity')
		}
	}
	if (scope === 'items' && state.itemIds.length === 0) {
		fail('target', 'choose_items')
	}
	if (scope === 'categories' && state.categoryIds.length === 0) {
		fail('target', 'choose_categories')
	}
	if (
		scope === 'modifiers' &&
		state.modifierGroupIds.length + state.modifierOptionIds.length === 0
	) {
		fail('target', 'choose_modifiers')
	}

	// Buy-some-discount-some counts matching items, so it needs a set of them.
	if (!freeDelivery && kind === 'bogo' && scope === 'order') {
		fail('quantityKind', 'bogo_needs_items')
	}
	// The schema caps how many things a discount can name. Say which list is
	// too long instead of a bare "check this setting".
	const tooMany = (
		count: number,
		max: number,
		field: string,
		code: EditorErrorCode,
	) => {
		if (count > max) fail(field, code)
	}
	if (scope === 'items') {
		tooMany(
			state.itemIds.length,
			DISCOUNT_MAX_TARGET_ITEMS,
			'target',
			'too_many_items',
		)
	}
	if (scope === 'categories') {
		tooMany(
			state.categoryIds.length,
			DISCOUNT_MAX_TARGET_CATEGORIES,
			'target',
			'too_many_categories',
		)
	}
	if (scope === 'modifiers') {
		tooMany(
			state.modifierGroupIds.length,
			DISCOUNT_MAX_TARGET_MODIFIER_GROUPS,
			'target',
			'too_many_modifiers',
		)
		tooMany(
			state.modifierOptionIds.length,
			DISCOUNT_MAX_TARGET_MODIFIER_OPTIONS,
			'modifier-options',
			'too_many_modifiers',
		)
		tooMany(
			state.itemIds.length,
			DISCOUNT_MAX_TARGET_ITEMS,
			'modifier-items',
			'too_many_items',
		)
		tooMany(
			state.categoryIds.length,
			DISCOUNT_MAX_TARGET_CATEGORIES,
			'modifier-categories',
			'too_many_categories',
		)
	}
	// "Only these options": at most a few option types, each once, and a
	// bounded number of values in each.
	const variantLimits = (rows: readonly VariantFilterRow[], field: string) => {
		const filters = cleanVariantRows(rows)
		if (
			filters.length > DISCOUNT_MAX_VARIANT_GROUPS ||
			filters.some(
				(filter) => filter.values.length > DISCOUNT_MAX_VARIANT_VALUES,
			)
		) {
			fail(field, 'too_many_variants')
		} else if (
			new Set(filters.map((filter) => filter.group)).size !== filters.length
		) {
			fail(field, 'invalid')
		}
		return filters
	}
	const targetVariants =
		scope !== 'order'
			? variantLimits(
					state.variants,
					scope === 'modifiers' ? 'modifier-variants' : 'variants',
				)
			: []
	if (!(scope === 'order' && freeDelivery)) {
		tooMany(
			state.excludeItemIds.length,
			DISCOUNT_MAX_TARGET_ITEMS,
			'exclude-items',
			'too_many_items',
		)
		tooMany(
			state.excludeCategoryIds.length,
			DISCOUNT_MAX_TARGET_CATEGORIES,
			'exclude-categories',
			'too_many_categories',
		)
	}

	let requirement: DiscountDefinition['requirement'] = null
	if (state.requireOn && !freeDelivery) {
		const quantity = whole(state.requireQuantity, 'requireQuantity')
		if (state.requireItemIds.length + state.requireCategoryIds.length === 0) {
			fail('requirement', 'choose_one')
		}
		tooMany(
			state.requireItemIds.length,
			DISCOUNT_MAX_TARGET_ITEMS,
			'requirement',
			'too_many_items',
		)
		tooMany(
			state.requireCategoryIds.length,
			DISCOUNT_MAX_TARGET_CATEGORIES,
			'require-categories',
			'too_many_categories',
		)
		if (quantity !== null) {
			requirement = {
				quantity,
				itemIds: state.requireItemIds,
				categoryIds: state.requireCategoryIds,
			}
		}
	}

	let tiers: DiscountDefinition['tiers'] = null
	if (tiered) {
		const spend = state.tierBasis === 'spend'
		if (spend && noAmounts) fail('tiers', 'limits_unavailable')
		const steps: NonNullable<DiscountDefinition['tiers']>['steps'] = []
		if (state.tiers.length === 0) fail('tiers', 'add_tier')
		let previous = 0
		state.tiers.forEach((row, index) => {
			const at = spend
				? noAmounts
					? null
					: parseMoneyToMinor(row.at, { currency, min: 1 })
				: parseWholeNumber(row.at, { min: 1, max: DISCOUNT_MAX_UNITS })
			if (at === null && !(spend && noAmounts)) {
				fail(
					`tiers.${index}.at`,
					spend ? 'amount' : rangeCode(1, DISCOUNT_MAX_UNITS),
				)
			}
			let stepPercent: number | null = null
			let stepAmount: number | null = null
			if (state.valueType === 'percent') {
				stepPercent = parsePercentToBp(row.value)
				if (stepPercent === null) fail(`tiers.${index}.value`, 'percent')
			} else if (!noAmounts) {
				stepAmount = parseMoneyToMinor(row.value, { currency, min: 1 })
				if (stepAmount === null) fail(`tiers.${index}.value`, 'amount')
			}
			if (at === null) return
			if (at <= previous) fail('tiers', 'tiers_ascending')
			previous = at
			steps.push({ at, percentBp: stepPercent, amountMinor: stepAmount })
		})
		tiers = { basis: state.tierBasis, steps }
	}

	let quantityRule: DiscountDefinition['quantityRule'] = { kind: 'none' }
	const groupLimits = (input: ItemGroupState, path: string) => {
		tooMany(
			input.itemIds.length,
			DISCOUNT_MAX_TARGET_ITEMS,
			`${path}.items`,
			'too_many_items',
		)
		tooMany(
			input.categoryIds.length,
			DISCOUNT_MAX_TARGET_CATEGORIES,
			`${path}.categories`,
			'too_many_categories',
		)
		return variantLimits(input.variants, `${path}.variants`)
	}
	const itemGroup = (
		input: ItemGroupState,
		path: string,
	): DiscountItemSet | null => {
		const quantity = whole(input.quantity, `${path}.quantity`)
		if (input.itemIds.length + input.categoryIds.length === 0) {
			fail(`${path}.items`, 'choose_one')
		}
		const variants = groupLimits(input, path)
		return quantity === null
			? null
			: {
					quantity,
					itemIds: input.itemIds,
					categoryIds: input.categoryIds,
					...(variants.length > 0 ? { variants } : {}),
				}
	}
	/** The buy side may count items or add up what is spent on them. */
	const buyGroup = (input: ItemGroupState): DiscountBuySet | null => {
		if (input.by !== 'spend') return itemGroup(input, 'buyGroup')
		const spendMinor = moneyField(input.spend, 'buyGroup.spend')
		if (input.itemIds.length + input.categoryIds.length === 0) {
			fail('buyGroup.items', 'choose_one')
		}
		const variants = groupLimits(input, 'buyGroup')
		return spendMinor === null
			? null
			: {
					spendMinor,
					itemIds: input.itemIds,
					categoryIds: input.categoryIds,
					...(variants.length > 0 ? { variants } : {}),
				}
	}
	if (!freeDelivery) {
		if (kind === 'per_item') {
			const quantity = whole(state.perItemN, 'perItemN')
			if (quantity !== null) quantityRule = { kind: 'per_item', quantity }
		} else if (kind === 'exact' || kind === 'minimum') {
			const quantity = whole(state.quantityN, 'quantityN', 2)
			if (quantity !== null) {
				quantityRule = { kind: kind, quantity }
			}
		} else if (kind === 'bogo') {
			const buyQuantity = whole(state.buyQuantity, 'buyQuantity')
			const getQuantity = whole(state.getQuantity, 'getQuantity')
			if (buyQuantity !== null && getQuantity !== null) {
				quantityRule = { kind: 'bogo', buyQuantity, getQuantity }
			}
		} else if (kind === 'buy_get') {
			const buy = buyGroup(state.buyGroup)
			const get = itemGroup(state.getGroup, 'getGroup')
			if (buy && get) quantityRule = { kind: 'buy_get', buy, get }
		} else if (kind === 'bundle') {
			if (state.bundleSlots.length === 0) fail('slots', 'choose_one')
			const slots = state.bundleSlots.map((slot, index) =>
				itemGroup(slot, `slots.${index}`),
			)
			if (slots.length > 0 && slots.every((slot) => slot !== null)) {
				const items = slots.reduce((sum, slot) => sum + slot.quantity, 0)
				if (items > DISCOUNT_MAX_BUNDLE_UNITS) fail('slots', 'bundle_too_big')
				else quantityRule = { kind: 'bundle', slots }
			}
		}
	}

	let maxDiscountedUnits: number | null = null
	if (
		!freeDelivery &&
		(scope !== 'order' || setRule) &&
		state.maxUnits.trim()
	) {
		maxDiscountedUnits = whole(state.maxUnits, 'maxUnits')
	}

	if (
		state.startsAt &&
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.startsAt)
	) {
		fail('startsAt', 'date')
	}
	if (state.endsAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.endsAt)) {
		fail('endsAt', 'date')
	}
	if (state.startsAt && state.endsAt && state.endsAt <= state.startsAt) {
		fail('endsAt', 'end_before_start')
	}

	let schedule: ScheduleRow[] | null = null
	if (state.hoursOn) {
		if (state.schedule.length === 0) fail('schedule', 'add_hours')
		if (state.schedule.length > DISCOUNT_MAX_SCHEDULE_WINDOWS) {
			fail('schedule', 'too_many_windows')
		}
		state.schedule.forEach((window, index) => {
			if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.start)) {
				fail(`schedule.${index}.start`, 'time')
			}
			if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.end)) {
				fail(`schedule.${index}.end`, 'time')
			} else if (window.start === window.end) {
				fail(`schedule.${index}.end`, 'same_time')
			}
		})
		schedule = state.schedule.map((window) => ({ ...window }))
	}

	// A channel the editor no longer offers is dropped on save.
	const channels = state.channels.filter(isEditorChannel)
	if (channels.length === 0) fail('channels', 'choose_one')
	if (state.fulfillments.length === 0) fail('fulfillments', 'choose_one')
	if (freeDelivery && !state.fulfillments.includes('delivery')) {
		fail('fulfillments', 'needs_delivery')
	}
	if (!state.allLocations && state.locationIds.length === 0) {
		fail('locations', 'choose_one')
	}

	let totalLimit: number | null = null
	if (state.totalLimit === 'custom') {
		totalLimit = whole(state.totalLimitCustom, 'totalLimit', 1, 1_000_000)
	} else if (state.totalLimit !== 'unlimited') {
		totalLimit = Number(state.totalLimit)
	}

	let perCustomerLimit: DiscountDefinition['perCustomerLimit'] = null
	if (state.perCustomerOn) {
		const count = whole(state.perCustomerCount, 'perCustomerCount', 1, 10_000)
		if (count !== null) {
			perCustomerLimit = { count, period: state.perCustomerPeriod }
		}
	}

	const priority = whole(state.priority || '0', 'priority', 0, 1000)

	const codes: CodeInput[] = []
	if (state.application === 'code') {
		// No code is allowed: the discount then only takes the single-use
		// codes marketing messages send (`{{couponCode}}`).
		if (state.codes.length > DISCOUNT_MAX_CODES) fail('codes', 'too_many_codes')
		const seen = new Set<string>()
		state.codes.forEach((row, index) => {
			const typed = row.code.trim()
			const field = `codes.${index}.code`
			if (!typed) return fail(field, 'required')
			if (!DISCOUNT_CODE_PATTERN.test(typed)) return fail(field, 'code_format')
			const normalized = normalizeDiscountCode(typed)
			if (normalized.length < 3) return fail(field, 'code_format')
			if (seen.has(normalized)) return fail(field, 'code_duplicate')
			seen.add(normalized)
			if (options.takenCodes?.has(normalized)) return fail(field, 'code_taken')
			let maxUses: number | null = null
			if (row.maxUses.trim()) {
				maxUses = parseWholeNumber(row.maxUses, { min: 1, max: 1_000_000 })
				if (maxUses === null) {
					fail(`codes.${index}.maxUses`, rangeCode(1, 1_000_000))
				}
			}
			codes.push({ id: row.id, code: typed, maxUses })
		})
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors }

	const candidate = {
		name,
		...(Object.keys(nameI18n).length > 0 ? { nameI18n } : {}),
		internalName: state.internalName.trim() || null,
		description,
		...(Object.keys(descriptionI18n).length > 0 ? { descriptionI18n } : {}),
		status: options.status,
		application: state.application,
		valueType: state.valueType,
		percentBp,
		amountMinor,
		currency:
			state.valueType === 'fixed' ||
			state.valueType === 'fixed_price' ||
			state.valueType === 'variable_amount' ||
			maxDiscountMinor !== null ||
			minSubtotalMinor !== null ||
			maxDeliveryFeeMinor !== null ||
			(tiers !== null && tiers.basis === 'spend') ||
			(state.quantityKind === 'buy_get' && state.buyGroup.by === 'spend')
				? currency
				: null,
		maxDiscountMinor,
		target: {
			scope,
			// For a modifier discount these narrow which items' choices count.
			itemIds: scope === 'items' || scope === 'modifiers' ? state.itemIds : [],
			categoryIds:
				scope === 'categories' || scope === 'modifiers'
					? state.categoryIds
					: [],
			excludeItemIds:
				scope === 'order' && freeDelivery ? [] : state.excludeItemIds,
			excludeCategoryIds:
				scope === 'order' && freeDelivery ? [] : state.excludeCategoryIds,
			...(scope === 'modifiers'
				? {
						modifierGroupIds: state.modifierGroupIds,
						modifierOptionIds: state.modifierOptionIds,
					}
				: {}),
			// Options narrow items, categories and modifier choices only.
			...(targetVariants.length > 0 ? { variants: targetVariants } : {}),
		},
		requirement,
		quantityRule,
		maxDiscountedUnits,
		minSubtotalMinor,
		locationIds: state.allLocations ? null : state.locationIds,
		channels,
		fulfillments: state.fulfillments,
		includeDrops: state.includeDrops,
		schedule,
		startsAt: state.startsAt || null,
		endsAt: state.endsAt || null,
		eligibility: state.eligibility,
		totalLimit,
		perCustomerLimit,
		combinable: state.combinesWith.length > 0,
		combinesWith: state.combinesWith,
		...(tiers ? { tiers } : {}),
		...(maxDeliveryFeeMinor !== null ? { maxDeliveryFeeMinor } : {}),
		priority: priority ?? 0,
		promoteOnMenu: state.promoteOnMenu && promoteOnMenuAllowed(state),
		requireApproval: state.requireApproval,
	}
	// The discount holds money but its locations use several currencies, so no
	// single currency can be stored with it. Mark the locations and the field.
	if (mixedCurrencies && candidate.currency !== null) {
		return {
			ok: false,
			errors: {
				locations: 'mixed_currencies',
				[currencyIssueField(state, {
					maxDiscount: maxDiscountMinor !== null,
					minSubtotal: minSubtotalMinor !== null,
					maxDeliveryFee: maxDeliveryFeeMinor !== null,
					tiers: tiers !== null,
				})]: 'mixed_currencies',
			},
		}
	}
	const parsed = discountDefinitionSchema.safeParse(candidate)
	if (!parsed.success) {
		const schemaErrors: EditorErrors = {}
		for (const issue of parsed.error.issues) {
			const field =
				issue.path[0] === 'currency'
					? currencyIssueField(state, {
							maxDiscount: maxDiscountMinor !== null,
							minSubtotal: minSubtotalMinor !== null,
							maxDeliveryFee: maxDeliveryFeeMinor !== null,
							tiers: tiers !== null,
						})
					: fieldForIssuePath(issue.path)
			schemaErrors[field] ??= 'invalid'
		}
		return { ok: false, errors: schemaErrors }
	}
	return { ok: true, definition: parsed.data, codes }
}

function cryptoRandom(): number {
	const bytes = new Uint32Array(1)
	crypto.getRandomValues(bytes)
	return (bytes[0] ?? 0) / 0x1_0000_0000
}

/** A short, readable code such as `SAVE-7K3QM2NP`, from an injectable random source. */
export function generateCode(random: () => number = cryptoRandom): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
	let suffix = ''
	for (let index = 0; index < 8; index += 1) {
		suffix += alphabet[Math.floor(random() * alphabet.length)]
	}
	return `SAVE-${suffix}`
}
