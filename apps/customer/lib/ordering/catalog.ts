import { guestCalorieView } from '@repo/common/calorie-display'
import { isSoldOn } from '@repo/common/menu-channels'
import {
	fixedOverridePrice,
	parseMenuPricingRules,
	resolveMenuItemPrice,
	type MenuOrderType,
	type MenuPricingRule,
} from '@repo/common/menu-pricing'
import {
	dietaryTagsOf,
	getLocalizedMenuValue,
	matchesDietaryFilter,
	type DietaryTag,
} from '@repo/common/menu-types'
import { localizedDiscountText } from '@repo/discounts'
import { z } from 'zod'
import { ApiError, notBoundToTenantError } from '../api/api-error'
import { fetchTransport, type HttpTransport } from '../api/http'
import { buildUrl, decodeResponse, performRequest } from '../api/request'
import { type TenantConfiguration } from '../config/configuration'
import { siteQuery } from '../support/site-address'
import { DEFAULT_OFFER_SCOPE, type OfferMode, type OfferScope } from './offers'

const channelsFieldSchema = z
	.union([z.array(z.string()), z.string()])
	.nullable()
	.optional()
	.catch(undefined)

const itemSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	description: z.string().nullish(),
	price: z.number(),
	availabilityStatus: z.string().optional(),
	channels: channelsFieldSchema,
	excludeFromDiscounts: z.boolean().optional().catch(undefined),
	// #335 and #412: read defensively, an older or newer menu never breaks the list.
	dietaryTags: z.array(z.string()).optional().catch(undefined),
	isVegetarian: z.boolean().optional().catch(undefined),
	isGlutenFree: z.boolean().optional().catch(undefined),
	orderTypePrices: z.unknown().optional(),
	calorieMin: z.number().nullable().optional().catch(undefined),
	calorieMax: z.number().nullable().optional().catch(undefined),
	variations: z
		.object({
			variants: z
				.array(
					z.object({
						id: z.string().optional().catch(undefined),
						price: z.number().optional().catch(undefined),
						availabilityStatus: z.string().optional(),
						excludeFromDiscounts: z.boolean().optional().catch(undefined),
					}),
				)
				.optional(),
		})
		.nullish(),
})

const categorySchema = z.object({
	id: z.string(),
	displayName: z.string(),
	availabilityStatus: z.string().optional(),
	channels: channelsFieldSchema,
	items: z.array(z.unknown()).optional(),
	subcategories: z.array(z.unknown()).optional(),
})

const menuSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	availabilityStatus: z.string().optional(),
	channels: channelsFieldSchema,
	categories: z.array(z.unknown()).optional(),
	showCalories: z.boolean().optional().catch(undefined),
	dailyIntake: z.enum(['us', 'ksa']).nullable().optional().catch(undefined),
})

const OFFER_MODES: readonly OfferMode[] = ['pickup', 'delivery', 'dine_in']

// The display fields fall back to the safe reading when malformed, so one bad
// field never drops an offer. An unknown `valueType` still drops it: the app
// cannot say what it is worth.
const promotionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullish(),
	// Per website language; a malformed map reads as none (the canonical text).
	nameI18n: z.record(z.string(), z.string()).nullish().catch(null),
	descriptionI18n: z.record(z.string(), z.string()).nullish().catch(null),
	valueType: z.enum(['percent', 'fixed', 'fixed_price', 'free_delivery']),
	percentBp: z.number().nullish(),
	amountMinor: z.number().nullish(),
	currency: z.string().nullish(),
	scope: z.enum(['order', 'items', 'categories']),
	itemIds: z.array(z.string()).optional(),
	categoryIds: z.array(z.string()).optional(),
	showName: z.boolean().optional().catch(undefined),
	itemBadges: z.boolean().optional().catch(undefined),
	itemPrice: z.boolean().optional().catch(undefined),
	schedule: z
		.array(z.object({ day: z.number(), start: z.string(), end: z.string() }))
		.nullish()
		.catch(null),
	excludeItemIds: z.array(z.string()).optional().catch(undefined),
	excludeCategoryIds: z.array(z.string()).optional().catch(undefined),
	locationIds: z.array(z.string()).nullish().catch(null),
	fulfillments: z.array(z.string()).nullish().catch(null),
	startsAt: z.string().nullish().catch(null),
	endsAt: z.string().nullish().catch(null),
	code: z.string().nullish().catch(null),
	// The limits of the offer (#273); a malformed value reads as none.
	maxDiscountMinor: z.number().int().positive().optional().catch(undefined),
	maxUnits: z.number().int().positive().optional().catch(undefined),
})

const locationSchema = z.object({
	id: z.string(),
	isDefault: z.boolean().optional(),
	timezone: z.string().nullish(),
	fulfillmentOptions: z
		.object({
			pickup: z.boolean().optional(),
			delivery: z.boolean().optional(),
		})
		.nullish()
		.catch(null),
})

const menuEnvelopeSchema = z.object({
	organization: z
		.object({
			currency: z.string().optional(),
		})
		.optional(),
	locations: z.array(z.unknown()).optional(),
	menus: z.array(z.unknown()).optional(),
	promotions: z.array(z.unknown()).optional(),
	locationOverrides: z
		.record(
			z.string(),
			z.array(
				z
					.object({
						entityId: z.string(),
						price: z.number().nullish(),
						isEnabled: z.boolean().nullish().catch(undefined),
						availabilityStatus: z.string().nullish().catch(undefined),
						channels: channelsFieldSchema,
					})
					.loose(),
			),
		)
		.optional()
		.catch(undefined),
	pricingRules: z.unknown().optional(),
})

const dropSchema = z.object({
	title: z.string(),
	slug: z.string(),
	description: z.string().nullish(),
	coverImageUrl: z.string().nullish(),
	status: z.string(),
	ordersOpenAt: z.string().nullish(),
	ordersCloseAt: z.string().nullish(),
	pickupDates: z.array(z.string()).optional(),
	pickupLocationNames: z.array(z.string()).optional(),
	pickupTimezone: z.string().nullish(),
})

const dropsEnvelopeSchema = z.object({
	drops: z.array(z.unknown()).optional(),
})

export type MenuPromotionView = {
	id: string
	name: string
	description: string | null
	valueType: 'percent' | 'fixed' | 'fixed_price' | 'free_delivery'
	percentBp: number | null
	amountMinor: number | null
	currency: string | null
	scope: 'order' | 'items' | 'categories'
	itemIds: string[]
	categoryIds: string[]
	/** Show the discount's own name: a cap, a set price or a deal has no one value. */
	showName: boolean
	/** Badge the items it covers. */
	itemBadges: boolean
	/** A plain percent or per-item amount off: the menu may show was/now prices. */
	itemPrice: boolean
	/** Weekly hours in the location's zone; missing means always. */
	schedule?: { day: number; start: string; end: string }[]
	excludeItemIds: string[]
	excludeCategoryIds: string[]
	/** The most a percentage takes off one order, in `currency` (#273). */
	maxDiscountMinor?: number
	/** The most items an offer covers in one order (#273). */
	maxUnits?: number
	/** Null means every location. */
	locationIds: string[] | null
	/** Null means every order type. */
	fulfillments: OfferMode[] | null
	/** Local wall-clock times in the location's time zone. */
	startsAt: string | null
	endsAt: string | null
	/** The code of a promoted code discount. */
	code: string | null
}

export type MenuItemView = {
	id: string
	name: string
	description: string | null
	/** The price for the website's first order type at its location (#412, #388). */
	price: number
	/** The delivery price, when delivery is offered and it differs (#412). */
	deliveryPrice?: number
	soldOut: boolean
	categoryIds: string[]
	/** The item, or a variant that can be ordered, never gets a discount. */
	excludeFromDiscounts: boolean
	/** Dietary tags (#335); unknown values dropped. */
	dietaryTags: DietaryTag[]
	/** Absent or null when this menu hides calories (#285). */
	calories?: string | null
}

export type MenuSectionView = {
	id: string
	name: string
	items: MenuItemView[]
}

export type PublishedMenu = {
	currency: string
	sections: MenuSectionView[]
	promotions: MenuPromotionView[]
	/** Where the offers are checked: the default location and its order types. */
	offerScope: OfferScope
}

export type PublishedDrop = {
	title: string
	slug: string
	description: string | null
	coverImageUrl: string | null
	status: string
	ordersOpenAt: string | null
	ordersCloseAt: string | null
	pickupDates: string[]
	pickupLocationNames: string[]
	pickupTimezone: string | null
}

export function emptyMenu(currency = 'USD'): PublishedMenu {
	return {
		currency,
		sections: [],
		promotions: [],
		offerScope: DEFAULT_OFFER_SCOPE,
	}
}

/** Major-unit menu prices (`10` is $10), matching the public menu payload. */
export function formatMenuPrice(
	amount: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(amount)
	} catch {
		return String(amount)
	}
}

export function presentMenu(
	payload: unknown,
	locale: string,
	defaultLocale: string,
): PublishedMenu {
	const envelope = menuEnvelopeSchema.safeParse(payload)
	if (!envelope.success) return emptyMenu()
	const currency = envelope.data.organization?.currency || 'USD'
	const promotions = (envelope.data.promotions ?? []).flatMap((value) => {
		const parsed = promotionSchema.safeParse(value)
		if (!parsed.success) return []
		return [
			{
				id: parsed.data.id,
				// The guest's language, the site's default language, then the
				// text the operator typed: the same order as menu names.
				name: localizedDiscountText(
					parsed.data.nameI18n,
					parsed.data.name,
					locale,
					defaultLocale,
				),
				description:
					localizedDiscountText(
						parsed.data.descriptionI18n,
						parsed.data.description ?? '',
						locale,
						defaultLocale,
					) || null,
				valueType: parsed.data.valueType,
				percentBp: parsed.data.percentBp ?? null,
				amountMinor: parsed.data.amountMinor ?? null,
				currency: parsed.data.currency ?? null,
				scope: parsed.data.scope,
				itemIds: parsed.data.itemIds ?? [],
				categoryIds: parsed.data.categoryIds ?? [],
				showName: parsed.data.showName ?? false,
				itemBadges: parsed.data.itemBadges ?? true,
				itemPrice: parsed.data.itemPrice ?? false,
				schedule: parsed.data.schedule?.length
					? parsed.data.schedule
					: undefined,
				excludeItemIds: parsed.data.excludeItemIds ?? [],
				excludeCategoryIds: parsed.data.excludeCategoryIds ?? [],
				...(parsed.data.maxDiscountMinor
					? { maxDiscountMinor: parsed.data.maxDiscountMinor }
					: {}),
				...(parsed.data.maxUnits ? { maxUnits: parsed.data.maxUnits } : {}),
				locationIds: parsed.data.locationIds ?? null,
				fulfillments: parsed.data.fulfillments
					? parsed.data.fulfillments.filter((mode): mode is OfferMode =>
							OFFER_MODES.includes(mode as OfferMode),
						)
					: null,
				startsAt: parsed.data.startsAt || null,
				endsAt: parsed.data.endsAt || null,
				code: parsed.data.code?.trim() || null,
			},
		]
	})
	const offerScope = offerScopeOf(envelope.data.locations ?? [])
	const pricing: PricingScope = {
		locationId: offerScope.locationId,
		modes: offerScope.modes,
		rules: parseMenuPricingRules(envelope.data.pricingRules),
		overrides: offerScope.locationId
			? (envelope.data.locationOverrides?.[offerScope.locationId] ?? [])
			: [],
	}
	const sections: MenuSectionView[] = []
	const menuCount = (envelope.data.menus ?? []).length
	for (const menuValue of envelope.data.menus ?? []) {
		const menu = menuSchema.safeParse(menuValue)
		if (!menu.success) continue
		const menuOverride = pricing.overrides.find(
			(ov) => ov.entityId === menu.data.id,
		)
		if (
			menu.data.availabilityStatus === 'unavailable' ||
			menuOverride?.isEnabled === false ||
			menuOverride?.availabilityStatus === 'hidden' ||
			menuOverride?.availabilityStatus === 'unavailable' ||
			!isSoldOn('app', { menu: menu.data, override: menuOverride })
		) {
			continue
		}
		const menuName = textOf(menu.data.displayName, locale, defaultLocale)
		walkCategories(
			menu.data.categories ?? [],
			[],
			menuCount > 1 ? menuName : null,
			locale,
			defaultLocale,
			sections,
			pricing,
			menu.data.showCalories !== false,
			menu.data.dailyIntake === 'ksa'
				? 'ksa'
				: menu.data.dailyIntake === 'us'
					? 'us'
					: null,
		)
	}
	return { currency, sections, promotions, offerScope }
}

/**
 * The location the website menu opens on (the default one, else the first)
 * decides the time zone and the order types, as it does on the website. A
 * table order needs a table, which this app cannot start, so `dine_in` is not
 * one of the modes.
 */
function offerScopeOf(locations: unknown[]): OfferScope {
	const parsed = locations.flatMap((value) => {
		const location = locationSchema.safeParse(value)
		return location.success ? [location.data] : []
	})
	const active = parsed.find((location) => location.isDefault) ?? parsed[0]
	if (!active) return DEFAULT_OFFER_SCOPE
	const modes: OfferMode[] = []
	if (active.fulfillmentOptions?.pickup !== false) modes.push('pickup')
	if (active.fulfillmentOptions?.delivery !== false) modes.push('delivery')
	return {
		locationId: active.id,
		timeZone: active.timezone || 'UTC',
		modes: modes.length > 0 ? modes : ['pickup'],
	}
}

export function presentDrops(payload: unknown): PublishedDrop[] {
	const envelope = dropsEnvelopeSchema.safeParse(payload)
	if (!envelope.success) return []
	return (envelope.data.drops ?? []).flatMap((value) => {
		const parsed = dropSchema.safeParse(value)
		if (!parsed.success) return []
		const cover = parsed.data.coverImageUrl?.trim() ?? ''
		return [
			{
				title: parsed.data.title,
				slug: parsed.data.slug,
				description: parsed.data.description ?? null,
				coverImageUrl:
					cover.startsWith('https://') || cover.startsWith('http://')
						? cover
						: null,
				status: parsed.data.status,
				ordersOpenAt: parsed.data.ordersOpenAt ?? null,
				ordersCloseAt: parsed.data.ordersCloseAt ?? null,
				pickupDates: parsed.data.pickupDates ?? [],
				pickupLocationNames: parsed.data.pickupLocationNames ?? [],
				pickupTimezone: parsed.data.pickupTimezone ?? null,
			},
		]
	})
}

export async function fetchPublishedMenu(
	configuration: TenantConfiguration,
	transport: HttpTransport = fetchTransport,
): Promise<unknown> {
	return fetchSiteResource(configuration, transport, '/resources/sites/menu', [
		['channel', 'app'],
	])
}

export async function fetchPublishedDrops(
	configuration: TenantConfiguration,
	transport: HttpTransport = fetchTransport,
): Promise<unknown> {
	return fetchSiteResource(configuration, transport, '/resources/sites/drops')
}

async function fetchSiteResource(
	configuration: TenantConfiguration,
	transport: HttpTransport,
	path: '/resources/sites/menu' | '/resources/sites/drops',
	extraQuery: Array<[string, string]> = [],
): Promise<unknown> {
	const binding = siteQuery(configuration.siteAddress)
	if (!binding) throw notBoundToTenantError()
	const response = await performRequest(transport, {
		method: 'GET',
		url: buildUrl(configuration.appBaseUrl, path, [
			[binding.name, binding.value],
			...extraQuery,
		]),
		headers: { Accept: 'application/json' },
		timeoutMs: configuration.requestTimeoutMs,
	})
	return decodeResponse(response, z.unknown(), path)
}

export function isMissingCatalog(error: unknown): boolean {
	return error instanceof ApiError && error.isNotFound
}

function calorieField(
	show: boolean,
	calorieMin: number | null | undefined,
	calorieMax: number | null | undefined,
	dataRegion: 'us' | 'ksa' | null,
): { calories: string } | Record<string, never> {
	const label = calorieLabel(show, calorieMin, calorieMax, dataRegion)
	return label ? { calories: label } : {}
}

function calorieLabel(
	show: boolean,
	calorieMin: number | null | undefined,
	calorieMax: number | null | undefined,
	dataRegion: 'us' | 'ksa' | null,
): string | null {
	const view = guestCalorieView({
		show,
		dish: { calorieMin: calorieMin ?? null, calorieMax: calorieMax ?? null },
		dataRegion,
	})
	if (!view.visible) return null
	return view.min === view.max ? `${view.min}` : `${view.min}–${view.max}`
}

function textOf(value: string, locale: string, defaultLocale: string): string {
	return getLocalizedMenuValue(value, locale, defaultLocale)
}

type PricingScope = {
	locationId: string | null
	modes: readonly OfferMode[]
	rules: MenuPricingRule[]
	overrides: Array<{
		entityId: string
		price?: number | null
		isEnabled?: boolean | null
		availabilityStatus?: string | null
		channels?: readonly string[] | string | null
	}>
}

/** The price shown for one order type, with the resolver the region charges with. */
function priceFor(
	item: z.infer<typeof itemSchema>,
	categoryIds: string[],
	pricing: PricingScope,
	orderType: MenuOrderType,
): number {
	const overridePrice = fixedOverridePrice(
		pricing.overrides.find((entry) => entry.entityId === item.id)?.price,
	)
	const context = {
		orderType,
		locationId: pricing.locationId,
		rules: pricing.rules,
	}
	const scope = { ...item, categoryIds }
	const variants = (item.variations?.variants ?? []).filter(
		(variant) => typeof variant.price === 'number',
	)
	if (variants.length > 0) {
		const orderable = variants.filter(
			(variant) => variant.availabilityStatus !== 'unavailable',
		)
		return Math.min(
			...(orderable.length ? orderable : variants).map((variant) =>
				resolveMenuItemPrice(scope, context, {
					variantPrice: variant.price,
					overridePrice,
				}),
			),
		)
	}
	return resolveMenuItemPrice(scope, context, { overridePrice })
}

/**
 * Sections narrowed to dishes with every chosen dietary tag (#335); a vegan
 * dish counts as vegetarian. Sections left empty are dropped.
 */
export function filterSectionsByDiet(
	sections: MenuSectionView[],
	selected: readonly string[],
): MenuSectionView[] {
	if (selected.length === 0) return sections
	return sections.flatMap((section) => {
		const items = section.items.filter((item) =>
			matchesDietaryFilter(item.dietaryTags, selected),
		)
		return items.length > 0 ? [{ ...section, items }] : []
	})
}

/** Tags at least one dish carries, in the canonical order (the filter's chips). */
export function dietaryTagsOnMenu(sections: MenuSectionView[]): DietaryTag[] {
	const used = new Set<DietaryTag>()
	for (const section of sections)
		for (const item of section.items)
			for (const tag of item.dietaryTags) used.add(tag)
	if (used.has('vegan')) used.add('vegetarian')
	return dietaryTagsOf({ dietaryTags: [...used] })
}

function walkCategories(
	values: unknown[],
	parentIds: string[],
	menuName: string | null,
	locale: string,
	defaultLocale: string,
	sections: MenuSectionView[],
	pricing: PricingScope,
	showCalories = true,
	dataRegion: 'us' | 'ksa' | null = null,
) {
	for (const value of values) {
		const category = categorySchema.safeParse(value)
		if (!category.success) continue
		const categoryOverride = pricing.overrides.find(
			(ov) => ov.entityId === category.data.id,
		)
		if (
			category.data.availabilityStatus === 'unavailable' ||
			categoryOverride?.isEnabled === false ||
			categoryOverride?.availabilityStatus === 'hidden' ||
			categoryOverride?.availabilityStatus === 'unavailable' ||
			!isSoldOn('app', { category: category.data, override: categoryOverride })
		) {
			continue
		}
		const categoryIds = [...parentIds, category.data.id]
		const name = textOf(category.data.displayName, locale, defaultLocale)
		const items = (category.data.items ?? []).flatMap((itemValue) => {
			const item = itemSchema.safeParse(itemValue)
			if (!item.success) return []
			const itemOverride = pricing.overrides.find(
				(ov) => ov.entityId === item.data.id,
			)
			if (
				itemOverride?.isEnabled === false ||
				itemOverride?.availabilityStatus === 'hidden' ||
				!isSoldOn('app', { item: item.data, override: itemOverride })
			) {
				return []
			}
			const variants = item.data.variations?.variants ?? []
			const soldOut =
				item.data.availabilityStatus === 'unavailable' ||
				(variants.length > 0 &&
					variants.every(
						(variant) => variant.availabilityStatus === 'unavailable',
					))
			return [
				{
					id: item.data.id,
					name: textOf(item.data.displayName, locale, defaultLocale),
					description: item.data.description
						? textOf(item.data.description, locale, defaultLocale)
						: null,
					...prices(item.data, categoryIds, pricing),
					soldOut,
					categoryIds,
					dietaryTags: dietaryTagsOf(item.data),
					...calorieField(
						showCalories,
						item.data.calorieMin,
						item.data.calorieMax,
						dataRegion,
					),
					excludeFromDiscounts:
						item.data.excludeFromDiscounts === true ||
						variants.some(
							(variant) =>
								variant.availabilityStatus !== 'unavailable' &&
								variant.excludeFromDiscounts === true,
						),
				},
			]
		})
		if (items.length > 0) {
			sections.push({
				id: category.data.id,
				name: menuName ? `${menuName} · ${name}` : name,
				items,
			})
		}
		walkCategories(
			category.data.subcategories ?? [],
			categoryIds,
			menuName,
			locale,
			defaultLocale,
			sections,
			pricing,
			showCalories,
			dataRegion,
		)
	}
}

function prices(
	item: z.infer<typeof itemSchema>,
	categoryIds: string[],
	pricing: PricingScope,
): { price: number; deliveryPrice?: number } {
	const first: MenuOrderType = pricing.modes[0] ?? 'pickup'
	const price = priceFor(item, categoryIds, pricing, first)
	if (first === 'delivery' || !pricing.modes.includes('delivery'))
		return { price }
	const delivery = priceFor(item, categoryIds, pricing, 'delivery')
	return Math.abs(delivery - price) >= 0.005
		? { price, deliveryPrice: delivery }
		: { price }
}
