import { defineMiddleware } from 'astro:middleware'
import { ENV } from 'varlock/env'

const CACHE_CONTROL_STATIC = 's-maxage=3600, stale-while-revalidate=86400'
const CACHE_CONTROL_NO_CACHE = 'no-store, no-cache, must-revalidate'

function getPostHogOrigin() {
	if (!ENV.PUBLIC_POSTHOG_PROJECT_TOKEN?.startsWith('phc_')) return null
	try {
		return new URL(ENV.PUBLIC_POSTHOG_HOST).origin
	} catch {
		return null
	}
}

const posthogOrigin = getPostHogOrigin()
const posthogSources = posthogOrigin
	? `${posthogOrigin} https://*.posthog.com`
	: ''

const securityHeaders = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${posthogSources}; connect-src 'self' ${posthogSources}; worker-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self';`,
}

function shouldSkipCache(pathname: string): boolean {
	return (
		pathname.startsWith('/api/') ||
		pathname === '/preview' ||
		pathname.startsWith('/preview/') ||
		pathname.includes('/_')
	)
}

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next()
	const { pathname } = context.url

	const newHeaders = new Headers(response.headers)
	const isPreview = pathname === '/preview' || pathname.startsWith('/preview/')
	const isHtml = response.headers
		.get('Content-Type')
		?.toLowerCase()
		.includes('text/html')

	for (const [key, value] of Object.entries(securityHeaders)) {
		if (isPreview && key === 'X-Frame-Options') {
			continue
		}

		if (isPreview && key === 'Content-Security-Policy') {
			newHeaders.set(key, `${value} frame-ancestors 'self';`)
			continue
		}

		newHeaders.set(key, value)
	}

	// HTML varies by shared theme and consent cookies. Never place one visitor's
	// rendered preference state in the shared edge cache.
	if (isHtml) {
		newHeaders.set('Cache-Control', 'private, no-cache')
	} else if (shouldSkipCache(pathname)) {
		newHeaders.set('Cache-Control', CACHE_CONTROL_NO_CACHE)
	} else {
		newHeaders.set('Cache-Control', CACHE_CONTROL_STATIC)
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	})
})
