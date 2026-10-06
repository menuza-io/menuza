import {
	type ShopCheckoutCspOptions,
	getShopCheckoutConnectSrc,
	getShopCheckoutFrameSources,
	getShopCheckoutScriptSrc,
} from '@repo/payments/shop/client'

const CLOUDFLARE_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com'
const CLOUDFLARE_INSIGHTS_CONNECT = 'https://cloudflareinsights.com'
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

// Google Analytics / Google Tag Manager (loaded off-thread by Partytown)
const GA_SCRIPT_SRC = 'https://www.googletagmanager.com'
const GA_CONNECT_SRC = [
	'https://www.google-analytics.com',
	'https://analytics.google.com',
	'https://www.googletagmanager.com',
]

export function sitesScriptSrc(isDev: boolean) {
	const evalSrc = isDev ? " 'unsafe-eval'" : ''
	return `script-src 'self' 'unsafe-inline'${evalSrc} ${CLOUDFLARE_INSIGHTS_SCRIPT} ${GA_SCRIPT_SRC} ${TURNSTILE_ORIGIN}`
}

export function sitesConnectSrc(origins: string[]) {
	return [
		'connect-src',
		"'self'",
		...origins,
		CLOUDFLARE_INSIGHTS_CONNECT,
		...GA_CONNECT_SRC,
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
	return true
}

const APP_ROUTE_SLUGS = new Set([
	'login',
	'verify',
	'complete-name',
	'profile',
	'shop',
	'menu',
])

export function isSitesShopRoute(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, '').startsWith('shop')
}

export function isSitesMenuRoute(pathname: string) {
	return pathname.replace(/^\/+|\/+$/g, '').startsWith('menu')
}

export function isSitesAppRoute(pathname: string) {
	const slug = pathname.replace(/^\/+|\/+$/g, '')
	if (APP_ROUTE_SLUGS.has(slug)) return true
	return isSitesShopRoute(pathname) || isSitesMenuRoute(pathname)
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
