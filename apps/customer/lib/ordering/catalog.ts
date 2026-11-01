import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { z } from 'zod'
import { ApiError, notBoundToTenantError } from '../api/api-error'
import { fetchTransport, type HttpTransport } from '../api/http'
import { buildUrl, decodeResponse, performRequest } from '../api/request'
import { type TenantConfiguration } from '../config/configuration'
import { siteQuery } from '../support/site-address'
import { DEFAULT_OFFER_SCOPE, type OfferMode, type OfferScope } from './offers'

const itemSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	description: z.string().nullish(),
	price: z.number(),
	availabilityStatus: z.string().optional(),
	excludeFromDiscounts: z.boolean().optional().catch(undefined),
	variations: z
		.object({
			variants: z
				.array(
					z.object({
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
	items: z.array(z.unknown()).optional(),
	subcategories: z.array(z.unknown()).optional(),
})

const menuSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	categories: z.array(z.unknown()).optional(),
})

const OFFER_MODES: readonly OfferMode[] = ['pickup', 'delivery', 'dine_in']

// The display fields fall back to the safe reading when malformed, so one bad
// field never drops an offer. An unknown `valueType` still drops it: the app
// cannot say what it is worth.
const promotionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().nullish(),
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
	price: number
	soldOut: boolean
	categoryIds: string[]
	/** The item, or a variant that can be ordered, never gets a discount. */
	excludeFromDiscounts: boolean
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
				name: parsed.data.name,
				description: parsed.data.description ?? null,
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
	const sections: MenuSectionView[] = []
	const menuCount = (envelope.data.menus ?? []).length
	for (const menuValue of envelope.data.menus ?? []) {
		const menu = menuSchema.safeParse(menuValue)
		if (!menu.success) continue
		const menuName = textOf(menu.data.displayName, locale, defaultLocale)
		walkCategories(
			menu.data.categories ?? [],
			[],
			menuCount > 1 ? menuName : null,
			locale,
			defaultLocale,
			sections,
		)
	}
	return {
		currency,
		sections,
		promotions,
		offerScope: offerScopeOf(envelope.data.locations ?? []),
	}
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
	return fetchSiteResource(configuration, transport, '/resources/sites/menu')
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
): Promise<unknown> {
	const binding = siteQuery(configuration.siteAddress)
	if (!binding) throw notBoundToTenantError()
	const response = await performRequest(transport, {
		method: 'GET',
		url: buildUrl(configuration.appBaseUrl, path, [
			[binding.name, binding.value],
		]),
		headers: { Accept: 'application/json' },
		timeoutMs: configuration.requestTimeoutMs,
	})
	return decodeResponse(response, z.unknown(), path)
}

export function isMissingCatalog(error: unknown): boolean {
	return error instanceof ApiError && error.isNotFound
}

function textOf(value: string, locale: string, defaultLocale: string): string {
	return getLocalizedMenuValue(value, locale, defaultLocale)
}

function walkCategories(
	values: unknown[],
	parentIds: string[],
	menuName: string | null,
	locale: string,
	defaultLocale: string,
	sections: MenuSectionView[],
) {
	for (const value of values) {
		const category = categorySchema.safeParse(value)
		if (!category.success) continue
		if (category.data.availabilityStatus === 'unavailable') continue
		const categoryIds = [...parentIds, category.data.id]
		const name = textOf(category.data.displayName, locale, defaultLocale)
		const items = (category.data.items ?? []).flatMap((itemValue) => {
			const item = itemSchema.safeParse(itemValue)
			if (!item.success) return []
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
					price: item.data.price,
					soldOut,
					categoryIds,
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
		)
	}
}
