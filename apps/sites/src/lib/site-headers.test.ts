import { describe, expect, it } from 'vitest'
import {
	asAstroResponse,
	isSitesAppRoute,
	publishedHtmlCacheUrl,
	shouldCachePublishedHtml,
	sitesConnectSrc,
	sitesScriptSrc,
} from './site-headers.ts'

describe('sitesScriptSrc', () => {
	it('allows Cloudflare Insights and inline scripts in production', () => {
		expect(sitesScriptSrc(false)).toContain(
			'https://static.cloudflareinsights.com',
		)
		expect(sitesScriptSrc(false)).toContain('https://challenges.cloudflare.com')
		expect(sitesScriptSrc(false)).toContain("'unsafe-inline'")
		expect(sitesScriptSrc(false)).not.toContain('unsafe-eval')
	})

	it('keeps unsafe-eval for Vite in development only', () => {
		expect(sitesScriptSrc(true)).toContain("'unsafe-eval'")
	})
})

describe('sitesConnectSrc', () => {
	it('allows Cloudflare Insights beacons', () => {
		expect(sitesConnectSrc(['https://app.example'])).toContain(
			'https://cloudflareinsights.com',
		)
	})
})

describe('isSitesAppRoute', () => {
	it('treats auth pages as app routes so CMS prefetch is skipped', () => {
		expect(isSitesAppRoute('/login')).toBe(true)
		expect(isSitesAppRoute('/profile')).toBe(true)
		expect(isSitesAppRoute('/')).toBe(false)
		expect(isSitesAppRoute('/about')).toBe(false)
	})
})

describe('shouldCachePublishedHtml', () => {
	it('caches published GET HTML in production', () => {
		const request = new Request('https://acme.example/', { method: 'GET' })
		expect(
			shouldCachePublishedHtml(request, new URL('https://acme.example/'), true),
		).toBe(true)
	})

	it('skips development, preview, API, and non-GET responses', () => {
		const get = new Request('https://acme.example/', { method: 'GET' })
		expect(
			shouldCachePublishedHtml(get, new URL('https://acme.example/'), false),
		).toBe(false)
		expect(
			shouldCachePublishedHtml(
				get,
				new URL('https://acme.example/?preview=true'),
				true,
			),
		).toBe(false)
		expect(
			shouldCachePublishedHtml(
				get,
				new URL('https://acme.example/api/health'),
				true,
			),
		).toBe(false)
		expect(
			shouldCachePublishedHtml(
				new Request('https://acme.example/', { method: 'POST' }),
				new URL('https://acme.example/'),
				true,
			),
		).toBe(false)
	})
})

describe('asAstroResponse', () => {
	it('returns a same-realm Response Astro will accept', async () => {
		const cached = new Response('<html>ok</html>', {
			status: 200,
			headers: { 'Content-Type': 'text/html' },
		})
		const response = asAstroResponse(cached)
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toBe('<html>ok</html>')
	})
})

describe('publishedHtmlCacheUrl', () => {
	it('keys cache entries by the public Host header, not the worker origin', () => {
		const requestUrl = new URL('https://sites.example.workers.dev/')
		expect(
			publishedHtmlCacheUrl(requestUrl, 'acme12.preview.example.dev').href,
		).toBe('https://acme12.preview.example.dev/')
		expect(
			publishedHtmlCacheUrl(requestUrl, 'acme13.preview.example.dev').href,
		).toBe('https://acme13.preview.example.dev/')
	})

	it('normalizes casing and trims whitespace on host headers', () => {
		const requestUrl = new URL('https://sites.example.workers.dev/page')
		expect(
			publishedHtmlCacheUrl(requestUrl, '  ACME12.Preview.Example.Dev:443  ')
				.href,
		).toBe('https://acme12.preview.example.dev/page')
	})
})
