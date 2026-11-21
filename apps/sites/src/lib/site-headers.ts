import { createHash } from 'node:crypto'
import {
	cacheControlBeforeBoundary,
	nextAnnouncementBoundary,
	type AnnouncementWindow,
} from '@repo/common/announcement-window'
import {
	type ShopCheckoutCspOptions,
	getShopCheckoutConnectSrc,
	getShopCheckoutFrameSources,
	getShopCheckoutScriptSrc,
} from '@repo/payments/shop/client'

const CLOUDFLARE_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com'
const CLOUDFLARE_INSIGHTS_CONNECT = 'https://cloudflareinsights.com'
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'
const FACEBOOK_SCRIPT = 'https://connect.facebook.net'
const TIKTOK_SCRIPT = 'https://analytics.tiktok.com'
const PIXEL_CONNECT_SRC = [
	'https://connect.facebook.net',
	'https://www.facebook.com',
	'https://analytics.tiktok.com',
]

// Google Analytics / Google Tag Manager (loaded off-thread by Partytown)
const GA_SCRIPT_SRC = 'https://www.googletagmanager.com'
const GA_CONNECT_SRC = [
	'https://www.google-analytics.com',
	'https://analytics.google.com',
	'https://www.googletagmanager.com',
]

/**
 * Runs before paint: theme class, deferred font activation, and the signed-in
 * marker. Kept inline so it is not deferred, and hashed so production CSP does
 * not need script-src 'unsafe-inline' (which would let a markup breakout read
 * the customer tokens in localStorage).
 */
export const SITES_BOOT_SCRIPT = `(function(){try{var root=document.documentElement;if(root.dataset.themeMode==='system'){root.classList.toggle('dark',window.matchMedia('(prefers-color-scheme: dark)').matches)}var links=document.querySelectorAll('link[data-defer-stylesheet]');for(var i=0;i<links.length;i++){var link=links[i];if(link.sheet){link.setAttribute('media','all')}else{link.addEventListener('load',function(){this.setAttribute('media','all')})}}if(localStorage.getItem('tenant_access_token')){root.dataset.customerSession='1'}}catch(e){}})()`

/** Production Partytown head snippet. Locked by site-headers.test.ts. */
export const PARTYTOWN_SCRIPT_HASH =
	"'sha256-FUzdwjA8djeqEDBUmi/iSbyxJRR0eWVZeot7zNmhrOo='"

function scriptHash(source: string) {
	return `'sha256-${createHash('sha256').update(source).digest('base64')}'`
}

const SCRIPT_HOSTS = [
	CLOUDFLARE_INSIGHTS_SCRIPT,
	GA_SCRIPT_SRC,
	TURNSTILE_ORIGIN,
	FACEBOOK_SCRIPT,
	TIKTOK_SCRIPT,
].join(' ')

export function sitesScriptSrc(isDev: boolean) {
	if (isDev) {
		return `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS}`
	}
	return `script-src 'self' ${scriptHash(SITES_BOOT_SCRIPT)} ${PARTYTOWN_SCRIPT_HASH} ${SCRIPT_HOSTS}`
}

/** Blocks onclick and other inline handlers. Dev keeps Vite's inline scripts. */
export function sitesScriptSrcAttr(isDev: boolean) {
	return isDev ? '' : "script-src-attr 'none'"
}

export function sitesConnectSrc(origins: string[]) {
	return [
		'connect-src',
		"'self'",
		...origins,
		CLOUDFLARE_INSIGHTS_CONNECT,
		...GA_CONNECT_SRC,
		...PIXEL_CONNECT_SRC,
	]
		.filter(Boolean)
		.join(' ')
}

export function sitesShopCheckoutScriptSrc(options: ShopCheckoutCspOptions) {
	return getShopCheckoutScriptSrc(options)
}

export function sitesShopCheckoutConnectSrc(options: ShopCheckoutCspOptions) {
	return getShopCheckoutConnectSrc(options)
}

/**
 * `frame-src`: the shop checkout and Turnstile, plus (#259) the origins of the
 * embed providers THIS page uses, and no others. A page with no Embed section
 * adds nothing; the origins come from the validated provider table, never from
 * what an operator pasted. `extraOrigins` are checked to be plain https
 * origins before they reach the header.
 */
export function sitesFrameSrc(
	options: ShopCheckoutCspOptions,
	extraOrigins: readonly string[] = [],
) {
	const sources = new Set([
		...getShopCheckoutFrameSources(options),
		TURNSTILE_ORIGIN,
		...extraOrigins.filter((origin) => /^https:\/\/[a-z0-9.-]+$/u.test(origin)),
	])
	return `frame-src ${Array.from(sources).join(' ')}`
}

/** Prefer Vite `MODE` — a schema `DEV` flag used to shadow `import.meta.env.DEV`. */
export function isSitesProduction() {
	return import.meta.env.MODE === 'production'
}
// Visibility affects listings and no-index on direct links. Do not serve
// previously rendered visibility decisions from the HTML edge cache.
export function isDropVisibilityPage(pathname: string) {
	const segments = pathname.split('/').filter(Boolean)
	if (segments.length === 0) return true
	if (segments.length === 1) {
		return (
			segments[0] === 'menu' || /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]!)
		)
	}
	const offset = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]!) ? 1 : 0
	return (
		(segments.length === offset + 1 && segments[offset] === 'menu') ||
		(segments.length === offset + 2 && segments[offset] === 'drop')
	)
}

/**
 * Careers pages list and show jobs that open, close and expire on their own,
 * so a cached copy could advertise a role that has ended. They are never
 * served from the HTML edge cache. Handles locale-prefixed paths like
 * `/ar/careers/line-cook`.
 */
export function isCareersPage(pathname: string) {
	const segments = pathname.split('/').filter(Boolean)
	const offset = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? '') ? 1 : 0
	return segments[offset] === 'careers'
}

/**
 * The booking pages read live availability and the manage page is a
 * capability link, so neither is ever served from the HTML edge cache.
 * Handles locale-prefixed paths like `/ar/reserve/manage`.
 */
export function isReservationsPage(pathname: string) {
	const segments = pathname.split('/').filter(Boolean)
	const offset = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? '') ? 1 : 0
	return segments[offset] === 'reserve'
}

/** How long a published page may be cached by the edge and by browsers. */
export const PUBLISHED_HTML_MAX_AGE = 60
export const PUBLISHED_HTML_STALE_WHILE_REVALIDATE = 300

/**
 * The `Cache-Control` of a cacheable published page. Announcement bars start
 * and end at set times, so a page showing (or hiding) one is never kept past
 * the next start or end: max-age plus the stale window ends at that boundary
 * (#238). With no upcoming boundary it is the usual lifetime.
 */
export function publishedHtmlCacheControl(
	announcements: readonly AnnouncementWindow[] | undefined,
	now = Date.now(),
) {
	return cacheControlBeforeBoundary(
		nextAnnouncementBoundary(announcements ?? [], now),
		now,
		{
			maxAge: PUBLISHED_HTML_MAX_AGE,
			staleWhileRevalidate: PUBLISHED_HTML_STALE_WHILE_REVALIDATE,
		},
	)
}

export function shouldCachePublishedHtml(
	request: Request,
	url: URL,
	isProduction = isSitesProduction(),
) {
	if (!isProduction) return false
	if (request.method !== 'GET') return false
	if (url.searchParams.has('preview')) return false
	if (url.pathname.startsWith('/api/')) return false
	if (isDropVisibilityPage(url.pathname)) return false
	if (isCareersPage(url.pathname)) return false
	if (isReservationsPage(url.pathname)) return false
	// Live pages: the options and the balance come from the region.
	if (isSitesGiftCardsRoute(url.pathname)) return false
	return true
}

const APP_ROUTE_SLUGS = new Set([
	'login',
	'verify',
	'complete-name',
	'profile',
	'shop',
	'menu',
	// Generated per site (src/pages): never a CMS page.
	'robots.txt',
	'sitemap.xml',
	'llms.txt',
])

export function isSitesShopRoute(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, '').startsWith('shop')
}

export function isSitesMenuRoute(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, '').startsWith('menu')
}

export function isSitesCareersRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return slug === 'careers' || slug.startsWith('careers/')
}

export function isSitesReservationsRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return slug === 'reserve' || slug.startsWith('reserve/')
}

export function isSitesGiftCardsRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return slug === 'gift-cards' || slug.startsWith('gift-cards/')
}

export function isSitesExperiencesRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return slug === 'experiences' || slug.startsWith('experiences/')
}

/**
 * Generated SEO pages (#137, #184): location, delivery area and event pages.
 * Their index routes (`/locations`, `/events`) look up an operator page at
 * the same path themselves, so the middleware need not.
 */
export function isSitesLandingRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return ['locations', 'delivery', 'events'].some(
		(prefix) => slug === prefix || slug.startsWith(`${prefix}/`),
	)
}

export function isSitesAppRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	if (APP_ROUTE_SLUGS.has(slug)) return true
	return (
		isSitesShopRoute(pathname) ||
		isSitesMenuRoute(pathname) ||
		isSitesCareersRoute(pathname) ||
		isSitesReservationsRoute(pathname) ||
		isSitesGiftCardsRoute(pathname) ||
		isSitesExperiencesRoute(pathname) ||
		isSitesLandingRoute(pathname)
	)
}

export function publishedHtmlCacheUrl(requestUrl: URL, host: string | null) {
	const cacheUrl = new URL(requestUrl)
	if (host) {
		const [hostname, port] = host.toLowerCase().trim().split(':')
		if (hostname) cacheUrl.hostname = hostname
		cacheUrl.port = port ?? ''
	}
	return cacheUrl
}

export function edgeCache(): Cache | null {
	const cachesApi = (globalThis as { caches?: { default?: Cache } }).caches
	return cachesApi?.default ?? null
}

/**
 * Cache API / cross-realm bodies fail Astro's `instanceof Response` check
 * (`MiddlewareNotAResponse`). Rebuild in this isolate before returning.
 */
export function asAstroResponse(response: Response): Response {
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers(response.headers),
	})
}
