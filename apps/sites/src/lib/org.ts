import {
	type PublicJobPosting,
	type PublicJobPostingListItem,
} from '@repo/common/job-posting'
import { type MenuChannel } from '@repo/common/menu-channels'
import { type DropStatus } from '@repo/common/menu-types'
import { type SiteFontSelection } from '@repo/common/site-fonts'
import { type PublicCustomerApp } from './customer-app-types'
import { edgeCache } from '~/lib/site-headers'
import { getAppServiceBinding, getPublicAppUrl } from '~/lib/worker-env'

export { type PublicCustomerApp }

export type PublicSiteCustomFont = {
	url: string
	format: 'woff2' | 'woff' | 'truetype' | 'opentype'
}

export type PublicSiteTheme = {
	baseColor: string
	theme: string
	radius: string
	mode: 'light' | 'dark' | 'system'
	headingFont?: SiteFontSelection
	bodyFont?: SiteFontSelection
	headingCustomFont?: PublicSiteCustomFont | null
	bodyCustomFont?: PublicSiteCustomFont | null
	css: string
}

export type PublicSiteAnnouncement = {
	id: string
	content: string
	type: 'info' | 'warning' | 'error' | 'success'
	linkUrl: string | null
	linkLabel: string | null
	linkNewTab: boolean
	/** The show window (#238), ISO (UTC); the page filters it per request. */
	startsAt?: string | null
	endsAt?: string | null
}

export type PublicSiteRedirect = {
	id: string
	fromPath: string
	toPath: string
	statusCode: number
}

import { type PublicActionTargets } from '@repo/common/action-targets'

export type PublicOrganization = {
	id: string
	name: string
	slug: string
	customDomain?: string | null
	/** The primary domain is live; a secondary host redirects to it only then (#139). */
	customDomainActive?: boolean
	dataRegion?: string | null
	theme?: PublicSiteTheme
	locales?: string[]
	defaultLocale?: string
	locale?: string
	siteIcon?: {
		original: string
		favicon32: string
		favicon16: string
		appleTouchIcon: string
	} | null
	announcements?: PublicSiteAnnouncement[]
	redirects?: PublicSiteRedirect[]
	facebookPixelId?: string | null
	googleTagManagerId?: string | null
	googleAnalyticsId?: string | null
	tiktokPixelId?: string | null
	/** Where Order, Gift cards and Reservations buttons go (#318); absent means Menuza. */
	actionTargets?: PublicActionTargets
	/** Cuisine keys (#182). Absent on payloads cached before the field existed. */
	cuisines?: string[]
	/** `$` to `$$$$` in the local currency symbol, or null (#182). */
	priceRange?: string | null
	/** Verification codes for the home page meta tags (#138). */
	siteVerification?: { google: string[]; bing: string | null }
	/** IndexNow key served at `/<key>.txt` (#138). */
	indexNowKey?: string | null
	/**
	 * Published legal pages by kind, as site paths (#89, #260). Absent on
	 * payloads cached before the field existed: no links are shown then.
	 */
	legalPages?: Partial<
		Record<'privacy' | 'terms' | 'cookies' | 'accessibility', string>
	>
	/** The cookie banner mode (#89); absent means `off` (tags load as before). */
	consent?: { mode: 'required' | 'notice' | 'off' }
	/** Absent on payloads cached before the field existed: no placements. */
	customerApp?: PublicCustomerApp | null
}

function getAppUrl(): string {
	return getPublicAppUrl()
}

async function fetchAppJson<T>(
	url: string,
	useCache = true,
): Promise<T | null> {
	const cache = useCache ? edgeCache() : null
	const cacheRequest = new Request(url, { method: 'GET' })
	if (cache) {
		const cached = await cache.match(cacheRequest)
		if (cached?.ok) {
			try {
				return (await cached.json()) as T
			} catch {
				/* fall through to network */
			}
		}
	}

	try {
		const appFetcher = getAppServiceBinding()
		const fetchImpl = appFetcher ? appFetcher.fetch.bind(appFetcher) : fetch
		const response = await fetchImpl(url, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(6_000),
		})
		if (!response.ok) return null
		const data = (await response.json()) as T
		if (cache) {
			void cache.put(
				cacheRequest,
				new Response(JSON.stringify(data), {
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'max-age=10',
					},
				}),
			)
		}
		return data
	} catch {
		return null
	}
}

async function postAppJson(url: string, body: unknown): Promise<boolean> {
	try {
		const appFetcher = getAppServiceBinding()
		const fetchImpl = appFetcher ? appFetcher.fetch.bind(appFetcher) : fetch
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(4_000),
		})
		return response.ok
	} catch {
		return false
	}
}

/** Counts a tap on a "Get the app" placement (#196): ids and enums only. */
export async function recordAppTap(options: {
	slug?: string | null
	host?: string | null
	placement: string
	store: string
}): Promise<boolean> {
	return postAppJson(`${getAppUrl()}/resources/sites/app-tap`, options)
}

export async function recordSiteRedirectHit(
	redirectId: string,
): Promise<boolean> {
	return postAppJson(`${getAppUrl()}/resources/sites/redirect-hit`, {
		id: redirectId,
	})
}

export async function recordSiteNotFound(options: {
	slug?: string | null
	host?: string | null
	path: string
	referrer?: string | null
	userAgent?: string | null
}): Promise<boolean> {
	return postAppJson(`${getAppUrl()}/resources/sites/not-found`, options)
}

async function fetchPublicOrganization(
	params: URLSearchParams,
): Promise<PublicOrganization | null> {
	const data = await fetchAppJson<PublicOrganization>(
		`${getAppUrl()}/resources/sites?${params.toString()}`,
	)
	if (!data?.name || !data?.slug) {
		return null
	}
	return data
}

export async function fetchPublishedOrganizationForHost(
	orgSlug: string | null,
	customHost: string | null,
	locale?: string | null,
): Promise<PublicOrganization | null> {
	if (orgSlug) return fetchPublishedOrganization(orgSlug, locale)
	if (customHost) return fetchPublishedOrganizationByHost(customHost, locale)
	return null
}

/**
 * Fetch a published organization by slug from the main app public API.
 */
export async function fetchPublishedOrganization(
	slug: string,
	locale?: string | null,
): Promise<PublicOrganization | null> {
	const params = new URLSearchParams({ slug })
	if (locale) params.set('lng', locale)
	return fetchPublicOrganization(params)
}

/**
 * Fetch a published organization by custom domain host.
 */
export async function fetchPublishedOrganizationByHost(
	host: string,
	locale?: string | null,
): Promise<PublicOrganization | null> {
	const params = new URLSearchParams({ host })
	if (locale) params.set('lng', locale)
	return fetchPublicOrganization(params)
}

export type PublicWebsitePageSection = {
	id: string
	type: string
	position: number
	config: any
}

export type PublicWebsitePage = {
	id: string
	title: string
	slug: string
	isHomePage: boolean
	seo?: {
		title: string
		description: string
		imageUrl: string | null
		noIndex: boolean
	}
	sections: PublicWebsitePageSection[]
	/** A running A/B test of one section (#338): variant B, localized like the section. */
	experiment?: { id: string; sectionId: string; variantConfig: unknown } | null
	/** Set by the App only after it verified the signed preview token. */
	previewVerified?: boolean
}

export async function fetchPublishedSitePage(options: {
	slug?: string | null
	host?: string | null
	pageSlug?: string
	home?: boolean
	preview?: boolean
	previewToken?: string | null
	lng?: string | null
}): Promise<PublicWebsitePage | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (options.home) params.set('home', 'true')
	if (options.pageSlug) params.set('page', options.pageSlug)
	if (options.preview) {
		params.set('preview', 'true')
		if (options.previewToken) params.set('pt', options.previewToken)
	}
	if (options.lng) params.set('lng', options.lng)

	return fetchAppJson<PublicWebsitePage>(
		`${getAppUrl()}/resources/sites/page?${params.toString()}`,
		!options.preview,
	)
}

export type PublicSitePageListing = {
	slug: string
	isHomePage: boolean
	/** In the site's default language. */
	title: string
	description: string | null
	updatedAt: string
}

/**
 * Published pages that may appear in search results (no drafts, no pages
 * marked "hide from search engines"), for `sitemap.xml` and `llms.txt`.
 */
export async function fetchPublishedSitePages(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicSitePageListing[]> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (!params.size) return []
	const data = await fetchAppJson<{ pages: PublicSitePageListing[] }>(
		`${getAppUrl()}/resources/sites/pages?${params.toString()}`,
	)
	return Array.isArray(data?.pages) ? data.pages : []
}

export type PublicShopProduct = {
	name: string
	description: string | null
	priceCents: number
	currency: string
	processor?: 'connect' | 'mor' | 'checkout'
	platformFeePercent: number
	platformFeeCents: number
	orgPayoutCents: number
}

export type PublicShopPayload = {
	available: true
	processor?: 'connect' | 'mor' | 'checkout'
	organization: { name: string; slug: string }
	product: PublicShopProduct
}

export type PublicShopOrderStatus = {
	status: string
	productName: string
	amountCents: number | null
	currency: string
}

export async function fetchPublishedShopProduct(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicShopPayload | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (!params.size) return null

	return fetchAppJson<PublicShopPayload>(
		`${getAppUrl()}/resources/sites/shop?${params.toString()}`,
	)
}

export async function fetchShopOrderStatus(options: {
	slug?: string | null
	host?: string | null
	sessionId?: string | null
	paymentIntentId?: string | null
	checkoutId?: string | null
	checkoutPaymentId?: string | null
}): Promise<PublicShopOrderStatus | null> {
	const params = new URLSearchParams()
	if (options.sessionId) params.set('session_id', options.sessionId)
	if (options.paymentIntentId) {
		params.set('payment_intent', options.paymentIntentId)
	}
	if (options.checkoutId) params.set('checkout_id', options.checkoutId)
	if (options.checkoutPaymentId) {
		params.set('cko_payment_id', options.checkoutPaymentId)
	}
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (
		!params.has('session_id') &&
		!params.has('payment_intent') &&
		!params.has('checkout_id') &&
		!params.has('cko_payment_id')
	) {
		return null
	}

	return fetchAppJson<PublicShopOrderStatus>(
		`${getAppUrl()}/resources/sites/shop/order?${params.toString()}`,
		false,
	)
}

/**
 * Creates a Stripe Checkout session via the App. Pass the browser's
 * `Authorization: Bearer <tenant access token>` when the customer is signed in;
 * omit it for guest checkout (customer identity is never taken from the body).
 */
export async function createShopCheckoutSession(
	body: { slug?: string; host?: string; embed?: boolean },
	authorization?: string | null,
) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
	}
	if (authorization) headers.Authorization = authorization

	const response = await fetch(`${getAppUrl()}/resources/sites/shop/checkout`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	})

	if (!response.ok) {
		return null
	}

	return response.json() as Promise<{
		checkoutUrl?: string
		sessionId?: string
		processor?: 'connect' | 'mor' | 'checkout'
		error?: string
	}>
}

/**
 * Creates an inline card payment via the App. Same auth model as checkout —
 * signed-in customers forward `Authorization`; guests omit it.
 */
export async function createShopPaymentIntent(
	body: { slug?: string; host?: string },
	authorization?: string | null,
) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
	}
	if (authorization) headers.Authorization = authorization

	const response = await fetch(
		`${getAppUrl()}/resources/sites/shop/payment-intent`,
		{
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		},
	)

	if (!response.ok) {
		try {
			const data = (await response.json()) as { error?: string }
			return { error: data.error || 'Payment setup failed' }
		} catch {
			return { error: 'Payment setup failed' }
		}
	}

	return response.json() as Promise<{
		clientSecret?: string
		paymentIntentId?: string
		publishableKey?: string
		error?: string
	}>
}

export type PublicLocationData = {
	id: string
	name: string
	slug: string
	phone: string | null
	timezone: string
	taxRate: number
	/**
	 * Menu prices already include tax (VAT). Absent on payloads cached before
	 * the field existed: treat as false (tax added on top).
	 */
	taxInclusive?: boolean
	/** Seller's tax (VAT) registration number, or null. */
	vatNumber?: string | null
	address: any
	currency?: 'USD' | 'CAD' | 'SAR'
	storeHours: any
	onlineHours: any
	specialHours: any
	prepTime: number
	fulfillmentOptions: any
	inHouseTips: any
	/** The tip buttons per order type, as saved (#118); null until saved. */
	tipSettings?: unknown
	scheduling: any
	deliveryConfig: any
	deliveryZones: any[]
	isDefault: boolean
	/** Station's ready texts (not used by Sites). Absent in older payloads. */
	readyText?: boolean
	/**
	 * Operator pause of web and QR ordering (null `until`: until resumed).
	 * Absent on payloads cached before the field existed.
	 */
	orderingPause?: { until: string | null } | null
	/** Busy mode: extra prep minutes while it lasts. */
	busyMode?: { extraPrepMinutes: number; until: string | null } | null
	onlineOrderingSettings?: unknown
	slotLimitSettings?: unknown
	isActive?: boolean | null
}

export type PublicMenuOptionData = {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	imageKey: string | null
	imageUrl: string | null
	/** Focal point of the photo (#394); absent or null is the centre. */
	imageFocal?: { x: number; y: number } | null
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
	/** Dietary tags (#335); read with `dietaryTagsOf` (unknown values dropped). */
	dietaryTags?: string[]
	/** Prices per order type (#412); read with `parseOrderTypePrices`. */
	orderTypePrices?: unknown
	isTopping: boolean
	isDefault: boolean
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	position: number
	nestedModifierGroupIds?: string[]
	nestedModifierGroups?: PublicModifierGroupData[]
}

export type PublicModifierGroupData = {
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

export type PublicMenuItemData = {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	price: number
	imageKey: string | null
	imageUrl: string | null
	imageKeys: string[]
	imageUrls: string[]
	/** Focal point of the primary photo (#394); absent or null is the centre. */
	imageFocal?: { x: number; y: number } | null
	/** Focals parallel to `imageUrls` (#394). */
	imageFocals?: Array<{ x: number; y: number } | null>
	/**
	 * A running photo test (#192): present only for the web and QR channels
	 * while the flag is on. `imageUrl` is always photo A.
	 */
	photoTest?: {
		id: string
		imageUrlB: string
		imageFocalB: { x: number; y: number } | null
		/** Signed by the App: the region counts a beacon only with it. */
		key?: string
	} | null
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
			imageFocal?: { x: number; y: number } | null
			availabilityStatus: 'available' | 'unavailable'
		}>
	}
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	/** Dietary tags (#335); read with `dietaryTagsOf` (unknown values dropped). */
	dietaryTags?: string[]
	/** Prices per order type (#412); read with `parseOrderTypePrices`. */
	orderTypePrices?: unknown
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	excludeFromDiscounts?: boolean
	/** Does not count toward order limits (#256), so not toward item counts (#355, #408). */
	excludeFromOrderLimits?: boolean
	availabilityStatus: string
	channels?: readonly string[] | string | null
	position: number
	modifierGroups: PublicModifierGroupData[]
}

export type PublicMenuCategoryData = {
	id: string
	displayName: string
	internalName: string | null
	description: string | null
	upsellCategoryIds: string[]
	parentId?: string | null
	subcategories?: PublicMenuCategoryData[]
	availabilityStatus: string
	channels?: readonly string[] | string | null
	position: number
	/** Every dish in it is left out of order limits (#256). */
	excludeFromOrderLimits?: boolean
	items: PublicMenuItemData[]
}

export type PublicMenuData = {
	id: string
	displayName: string
	internalName: string | null
	menuType: string
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus: string
	channels?: readonly string[] | string | null
	position: number
	categories: PublicMenuCategoryData[]
}

export type PublicMenuPromotion = {
	id: string
	name: string
	description: string | null
	/** `name` / `description` per website language (`localizePromotion`). */
	nameI18n?: Record<string, string>
	descriptionI18n?: Record<string, string>
	valueType: 'percent' | 'fixed' | 'fixed_price' | 'free_delivery'
	percentBp: number | null
	amountMinor: number | null
	currency: string | null
	/** `order` badges every item; otherwise the ids below decide. */
	scope: 'order' | 'items' | 'categories'
	itemIds: string[]
	categoryIds: string[]
	/** Show the discount's own name: it has no single value to put on a badge. */
	showName?: boolean
	/** `false`: banner only, no badge on items. Missing (older App): badge as before. */
	itemBadges?: boolean
	/** A plain percent or per-item amount off: the menu may show was/now prices. */
	itemPrice?: boolean
	/** Null or missing: every location. */
	locationIds?: string[] | null
	/** Order types the offer works for; missing: all. */
	fulfillments?: Array<'pickup' | 'delivery' | 'dine_in'>
	/** Local wall-clock ("2026-11-01T09:00") in the location's time zone. */
	startsAt?: string | null
	endsAt?: string | null
	schedule?: readonly {
		day: number
		start: string
		end: string
	}[]
	/** A promoted code discount's code, shown in the banner as "Use code X". */
	code?: string | null
	excludeItemIds?: string[]
	excludeCategoryIds?: string[]
	/** The most a percentage takes off one order (#273), in `currency`. Missing: no cap. */
	maxDiscountMinor?: number
	/** The most items an item offer covers in one order (#273). Missing: unlimited. */
	maxUnits?: number
}

export type PublicSiteMenuPayload = {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
		defaultLocale: string
		locales: string[]
	}
	locations: PublicLocationData[]
	menus: PublicMenuData[]
	/** Fixed per-location prices and availability, by location id. */
	locationOverrides?: Record<
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
	/** Live pricing rules (#388); read with `parseMenuPricingRules`. */
	pricingRules?: unknown
	promotions?: PublicMenuPromotion[]
	/**
	 * Site features the menu page reads: `upsell` is the `ordering.upsell` flag
	 * (#114). Absent on a payload cached before it: off. `dailyDishLimits`
	 * (#409) is a hint that spares the menu page a call: `false` means no daily
	 * limits, anything else (including absent) means ask the region.
	 */
	features?: {
		upsell?: boolean
		slotLimits?: boolean
		dailyDishLimits?: boolean
		qrOrdering?:
			boolean | { enabled?: boolean; dineIn?: boolean; online?: boolean }
	}
}

export async function fetchPublishedSiteMenu(options: {
	slug?: string | null
	host?: string | null
	lng?: string | null
	locationId?: string | null
	channel?: MenuChannel
	preview?: boolean
}): Promise<PublicSiteMenuPayload | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (options.lng) params.set('lng', options.lng)
	if (options.locationId) params.set('locationId', options.locationId)
	if (options.channel) params.set('channel', options.channel)
	if (options.preview) params.set('preview', '1')
	if (!params.size) return null

	return fetchAppJson<PublicSiteMenuPayload>(
		`${getAppUrl()}/resources/sites/menu?${params.toString()}`,
		!options.preview,
	)
}

export type PublicDropData = {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
	}
	drop: {
		id: string
		title: string
		slug: string
		description: string | null
		coverImageKey: string | null
		coverImageUrl: string | null
		status: DropStatus
		ordersOpenAt: string | null
		ordersCloseAt: string | null
		visibility: 'public' | 'unlisted'
		checkoutHoldMinutes: number
		showOrdersOpenTime: boolean
		showMenuPreview: boolean
		showInventoryRemaining: boolean
		includeGiftCard: boolean
		menu: {
			id: string
			displayName: string
			specialInstructions: boolean
		}
	}
	pickupWindows: Array<{
		id: string
		locationId: string
		location: {
			id: string
			name: string
			phone: string | null
			address: any
			timezone?: string
		} | null
		date: string
		startTime: string
		endTime: string
		slotIntervalMinutes: number
		maxOrdersPerSlot: number | null
		orderLeadTimeMinutes: number
		slots: Array<{ time: string; displayTime: string }>
	}>
	inventoryOverrides: Array<{
		id: string
		entityType: 'item' | 'category'
		entityId: string
		inventory: number | null
		maxPerOrder: number | null
		maxPerPickupSlot: number | null
	}>
	categories: Array<{
		id: string
		displayName: string
		internalName: string | null
		description: string | null
		items: PublicMenuItemData[]
	}>
}

export async function fetchPublishedDrop(options: {
	slug?: string | null
	host?: string | null
	dropSlug: string
	lng?: string | null
	preview?: boolean
}): Promise<PublicDropData | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	params.set('drop', options.dropSlug)
	if (options.lng) params.set('lng', options.lng)
	if (options.preview) params.set('preview', 'true')

	return fetchAppJson<PublicDropData>(
		`${getAppUrl()}/resources/sites/drop?${params.toString()}`,
		!options.preview,
	)
}

export type PublicDropListing = {
	title: string
	slug: string
	description: string | null
	coverImageUrl: string | null
	/** Customer-facing phase derived from the order window, never `draft`. */
	status: DropStatus
	ordersOpenAt: string | null
	ordersCloseAt: string | null
	/** Sorted unique `YYYY-MM-DD` pickup dates across all windows. */
	pickupDates: string[]
	/** Unique location names in pickup window order. */
	pickupLocationNames: string[]
	/** IANA timezone of the first pickup window's location. */
	pickupTimezone: string | null
}

export async function fetchPublishedDrops(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicDropListing[]> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (!params.size) return []

	const data = await fetchAppJson<{ drops: PublicDropListing[] }>(
		`${getAppUrl()}/resources/sites/drops?${params.toString()}`,
		false,
	)
	return data?.drops ?? []
}

export type PublicCareersListing = {
	organization: { name: string }
	postings: PublicJobPostingListItem[]
}

export type PublicCareersPosting = {
	organization: { name: string }
	posting: PublicJobPosting
}

function careersParams(options: {
	slug?: string | null
	host?: string | null
	/** The language the visitor reads; untranslated copy falls back to the default. */
	locale?: string | null
}): URLSearchParams | null {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (params.size && options.locale) params.set('locale', options.locale)
	return params.size ? params : null
}

/**
 * Live job postings for the careers page, or `null` when the organization has
 * no careers pages (site unpublished or `staffing.hiring` off). Public content
 * only: no person data crosses this call.
 */
export async function fetchPublishedCareers(options: {
	slug?: string | null
	host?: string | null
	locale?: string | null
}): Promise<PublicCareersListing | null> {
	const params = careersParams(options)
	if (!params) return null
	return fetchAppJson<PublicCareersListing>(
		`${getAppUrl()}/resources/sites/careers?${params.toString()}`,
		false,
	)
}

/** Which online-booking features the restaurant has on. */
export interface PublicReservationsGate {
	online: boolean
	waitlist: boolean
	experiences: boolean
	notifyMe: boolean
}

/**
 * The online-booking gate, or `null` when the module is off (`reservations.enabled`
 * and `reservations.online` are both required). Flags only: no guest data.
 */
export async function fetchPublishedReservations(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicReservationsGate | null> {
	const params = careersParams(options)
	if (!params) return null
	return fetchAppJson<PublicReservationsGate>(
		`${getAppUrl()}/resources/sites/reservations?${params.toString()}`,
		false,
	)
}

/** Whether the restaurant has loyalty on (flag only: no member data). */
export interface PublicLoyaltyGate {
	enabled: boolean
}

/** The loyalty gate, or `null` when the website is unpublished or loyalty is off. */
export async function fetchPublishedLoyalty(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicLoyaltyGate | null> {
	const params = careersParams(options)
	if (!params) return null
	return fetchAppJson<PublicLoyaltyGate>(
		`${getAppUrl()}/resources/sites/loyalty?${params.toString()}`,
		false,
	)
}

/** One live posting with its description and questions, or `null`. */
export async function fetchPublishedJobPosting(options: {
	slug?: string | null
	host?: string | null
	locale?: string | null
	posting: string
}): Promise<PublicCareersPosting | null> {
	const params = careersParams(options)
	if (!params) return null
	params.set('posting', options.posting)
	return fetchAppJson<PublicCareersPosting>(
		`${getAppUrl()}/resources/sites/careers?${params.toString()}`,
		false,
	)
}

export type PublicLandingLocation = {
	id: string
	slug: string
	name: string
	phone: string | null
	address: unknown
	storeHours: unknown
	specialHours: unknown
	timezone: string
	fulfillmentOptions: unknown
	isDefault: boolean
	/** Localized JSON text, or null. */
	intro: string | null
	seoTitle: string | null
	seoDescription: string | null
	cuisines: string[]
	priceRange: number | null
	updatedAt: string
}

export type PublicAreaPage = {
	slug: string
	locationId: string
	locationSlug: string
	zoneId: string
	name: string
	minimumOrder: number
	deliveryFee: number
	intro: string | null
	noIndex: boolean
}

/** Generated pages (#137): `GET /resources/sites/landing`. */
export type PublicLandingPayload = {
	features: {
		locationPages: boolean
		dishPages: boolean
		areaPages: boolean
		events: boolean
	}
	locations: PublicLandingLocation[]
	goneLocationSlugs: string[]
	dishes: Array<{ id: string; slug: string }>
	areas: PublicAreaPage[]
}

export async function fetchPublishedLanding(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicLandingPayload | null> {
	const params = careersParams(options)
	if (!params) return null
	return fetchAppJson<PublicLandingPayload>(
		`${getAppUrl()}/resources/sites/landing?${params.toString()}`,
	)
}

export type PublicSiteEvent = {
	slug: string
	title: string
	description: string
	imageUrl: string | null
	link: { url: string; label: string | null } | null
	experience: { id: string } | null
	location: { name: string; slug: string; address: unknown } | null
	timezone: string
	phase: 'upcoming' | 'ended' | 'gone'
	lastEndsAt: string | null
	occurrences: Array<{
		date: string
		start: string
		end: string
		startMs: number
		endMs: number
	}>
	updatedAt: string
}

/**
 * Published website events (#184), or `null` when the site has none (events
 * off or not published). `event` asks for one, ended ones included.
 */
export async function fetchPublishedEvents(options: {
	slug?: string | null
	host?: string | null
	lng?: string | null
	event?: string | null
}): Promise<{ events: PublicSiteEvent[] } | null> {
	const params = careersParams(options)
	if (!params) return null
	if (options.lng) params.set('lng', options.lng)
	if (options.event) params.set('event', options.event)
	// Occurrences move with the clock: never from the long-lived cache.
	return fetchAppJson<{ events: PublicSiteEvent[] }>(
		`${getAppUrl()}/resources/sites/events?${params.toString()}`,
		false,
	)
}
