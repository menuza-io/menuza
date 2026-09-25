import { type SiteFontSelection } from '@repo/common/site-fonts'
import { edgeCache } from '~/lib/site-headers'
import { getAppServiceBinding, getPublicAppUrl } from '~/lib/worker-env'

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
}

export type PublicSiteRedirect = {
	id: string
	fromPath: string
	toPath: string
	statusCode: number
}

export type PublicOrganization = {
	id: string
	name: string
	slug: string
	customDomain?: string | null
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
}

export async function fetchPublishedSitePage(options: {
	slug?: string | null
	host?: string | null
	pageSlug?: string
	home?: boolean
	preview?: boolean
	lng?: string | null
}): Promise<PublicWebsitePage | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (options.home) params.set('home', 'true')
	if (options.pageSlug) params.set('page', options.pageSlug)
	if (options.preview) params.set('preview', 'true')
	if (options.lng) params.set('lng', options.lng)

	return fetchAppJson<PublicWebsitePage>(
		`${getAppUrl()}/resources/sites/page?${params.toString()}`,
		!options.preview,
	)
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
	address: any
	currency?: 'USD' | 'CAD'
	storeHours: any
	onlineHours: any
	specialHours: any
	prepTime: number
	fulfillmentOptions: any
	inHouseTips: any
	scheduling: any
	deliveryConfig: any
	deliveryZones: any[]
	isDefault: boolean
}

export type PublicMenuOptionData = {
	id: string
	displayName: string
	internalName: string | null
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
	isTopping: boolean
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
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin: number | null
	calorieMax: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
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
	position: number
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
	position: number
	categories: PublicMenuCategoryData[]
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
}

export async function fetchPublishedSiteMenu(options: {
	slug?: string | null
	host?: string | null
	lng?: string | null
	locationId?: string | null
	preview?: boolean
}): Promise<PublicSiteMenuPayload | null> {
	const params = new URLSearchParams()
	if (options.slug) params.set('slug', options.slug)
	if (options.host) params.set('host', options.host)
	if (options.lng) params.set('lng', options.lng)
	if (options.locationId) params.set('locationId', options.locationId)
	if (options.preview) params.set('preview', '1')
	if (!params.size) return null

	return fetchAppJson<PublicSiteMenuPayload>(
		`${getAppUrl()}/resources/sites/menu?${params.toString()}`,
		!options.preview,
	)
}
