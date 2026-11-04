import { createHash } from 'node:crypto'
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

export function sitesFrameSrc(options: ShopCheckoutCspOptions) {
	const sources = new Set([
		...getShopCheckoutFrameSources(options),
		TURNSTILE_ORIGIN,
	])
	return `frame-src ${Array.from(sources).join(' ')}`
}

/** Prefer Vite `MODE` — a schema `DEV` flag used to shadow `import.meta.env.DEV`. */
export function isSitesProduction() {
	return import.meta.env.MODE === 'production'
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

export function shouldCachePublishedHtml(
	request: Request,
	url: URL,
	isProduction = isSitesProduction(),
) {
	if (!isProduction) return false
	if (request.method !== 'GET') return false
	if (url.searchParams.has('preview')) return false
	if (url.pathname.startsWith('/api/')) return false
	if (isCareersPage(url.pathname)) return false
	return true
}

const APP_ROUTE_SLUGS = new Set([
	'login',
	'verify',
	'complete-name',
	'profile',
	'shop',
])

export function isSitesShopRoute(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, '').startsWith('shop')
}

export function isSitesCareersRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	return slug === 'careers' || slug.startsWith('careers/')
}

export function isSitesAppRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	if (APP_ROUTE_SLUGS.has(slug)) return true
	return isSitesShopRoute(pathname) || isSitesCareersRoute(pathname)
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
