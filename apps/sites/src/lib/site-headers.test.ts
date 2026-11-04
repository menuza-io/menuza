import { describe, expect, it } from 'vitest'
import {
	asAstroResponse,
	isCareersPage,
	isDropVisibilityPage,
	isReservationsPage,
	isSitesAppRoute,
	publishedHtmlCacheUrl,
	shouldCachePublishedHtml,
	sitesConnectSrc,
	PARTYTOWN_SCRIPT_HASH,
	SITES_BOOT_SCRIPT,
	sitesScriptSrc,
	sitesScriptSrcAttr,
} from './site-headers.ts'

describe('sitesScriptSrc', () => {
	it('hashes the boot script and does not allow unsafe-inline in production', async () => {
		const { createHash } = await import('node:crypto')
		const bootHash = `'sha256-${createHash('sha256').update(SITES_BOOT_SCRIPT).digest('base64')}'`
		const policy = sitesScriptSrc(false)
		expect(policy).toContain('https://static.cloudflareinsights.com')
		expect(policy).toContain('https://challenges.cloudflare.com')
		expect(policy).toContain('https://connect.facebook.net')
		expect(policy).toContain('https://analytics.tiktok.com')
		expect(policy).toContain(PARTYTOWN_SCRIPT_HASH)
		expect(policy).toContain(bootHash)
		expect(policy).not.toContain('unsafe-inline')
		expect(policy).not.toContain('unsafe-eval')
		expect(sitesScriptSrcAttr(false)).toBe("script-src-attr 'none'")
	})

	it('keeps unsafe-inline and unsafe-eval for Vite in development only', () => {
		expect(sitesScriptSrc(true)).toContain("'unsafe-inline'")
		expect(sitesScriptSrc(true)).toContain("'unsafe-eval'")
		expect(sitesScriptSrcAttr(true)).toBe('')
	})

	it('matches the Partytown snippet this app injects in production', async () => {
		const { createHash } = await import('node:crypto')
		const { partytownSnippet } = await import('@qwik.dev/partytown/integration')
		const lib = '/~partytown/'
		const recreate = `;(e=>{e.addEventListener("astro:before-swap",e=>{let r=document.body.querySelector("iframe[src*='${lib}']");if(r)e.newDocument.body.append(r)})})(document);`
		const source =
			partytownSnippet({
				lib,
				forward: ['dataLayer.push', 'gtag'],
				debug: false,
			}) + recreate
		const hash = `'sha256-${createHash('sha256').update(source).digest('base64')}'`
		expect(PARTYTOWN_SCRIPT_HASH).toBe(hash)
		expect(SITES_BOOT_SCRIPT).not.toContain('unsafe')
	})
})

describe('sitesConnectSrc', () => {
	it('allows Cloudflare Insights beacons', () => {
		expect(sitesConnectSrc(['https://app.example'])).toContain(
			'https://cloudflareinsights.com',
		)
		expect(sitesConnectSrc(['https://app.example'])).toContain(
			'https://www.facebook.com',
		)
		expect(sitesConnectSrc(['https://app.example'])).toContain(
			'https://analytics.tiktok.com',
		)
	})
})

describe('isSitesAppRoute', () => {
	it('treats auth pages as app routes so CMS prefetch is skipped', () => {
		expect(isSitesAppRoute('/login')).toBe(true)
		expect(isSitesAppRoute('/profile')).toBe(true)
		expect(isSitesAppRoute('/menu')).toBe(true)
		expect(isSitesAppRoute('/menu/checkout')).toBe(true)
		expect(isSitesAppRoute('/careers')).toBe(true)
		expect(isSitesAppRoute('/careers/line-cook')).toBe(true)
		expect(isSitesAppRoute('/careers-and-more')).toBe(false)
		expect(isSitesAppRoute('/reserve')).toBe(true)
		expect(isSitesAppRoute('/reserve/manage')).toBe(true)
		expect(isSitesAppRoute('/reserve/pay')).toBe(true)
		expect(isSitesAppRoute('/reserve/pay/done')).toBe(true)
		expect(isSitesAppRoute('/experiences')).toBe(true)
		expect(isSitesAppRoute('/experiences/chefs-counter')).toBe(true)
		expect(isSitesAppRoute('/experiencesx')).toBe(false)
		expect(isSitesAppRoute('/reserved')).toBe(false)
		expect(isSitesAppRoute('/')).toBe(false)
		expect(isSitesAppRoute('/about')).toBe(false)
	})
})

describe('shouldCachePublishedHtml', () => {
	it('caches published GET HTML outside discovery pages in production', () => {
		const request = new Request('https://acme.example/about', { method: 'GET' })
		expect(
			shouldCachePublishedHtml(
				request,
				new URL('https://acme.example/about'),
				true,
			),
		).toBe(true)
	})

	it('does not cache drop listings or direct links, including locale-prefixed paths', () => {
		for (const path of [
			'/',
			'/menu',
			'/ar',
			'/ar/menu',
			'/fr-CA/menu',
			'/drop/weekend',
			'/ar/drop/weekend',
		]) {
			expect(isDropVisibilityPage(path)).toBe(true)
			expect(
				shouldCachePublishedHtml(
					new Request(`https://acme.example${path}`),
					new URL(`https://acme.example${path}`),
					true,
				),
			).toBe(false)
		}
		expect(isDropVisibilityPage('/menu/checkout')).toBe(false)
		expect(isDropVisibilityPage('/about')).toBe(false)
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

describe('careers pages', () => {
	it('are recognized with and without a locale prefix', () => {
		for (const path of [
			'/careers',
			'/careers/line-cook',
			'/ar/careers',
			'/ar/careers/line-cook',
			'/pt-br/careers',
		]) {
			expect(isCareersPage(path)).toBe(true)
		}
		for (const path of ['/', '/about', '/blog', '/ar', '/blog/careers']) {
			expect(isCareersPage(path)).toBe(false)
		}
	})

	it('are never served from the HTML edge cache', () => {
		for (const path of ['/careers', '/careers/line-cook', '/ar/careers/x']) {
			expect(
				shouldCachePublishedHtml(
					new Request(`https://acme.example${path}`, { method: 'GET' }),
					new URL(`https://acme.example${path}`),
					true,
				),
			).toBe(false)
		}
	})
})

describe('reservations pages', () => {
	it('are recognized with and without a locale prefix', () => {
		for (const path of ['/reserve', '/reserve/manage', '/ar/reserve/manage']) {
			expect(isReservationsPage(path)).toBe(true)
		}
		for (const path of ['/', '/about', '/blog/reserve', '/reserved']) {
			expect(isReservationsPage(path)).toBe(false)
		}
	})

	it('are never served from the HTML edge cache', () => {
		for (const path of [
			'/reserve',
			'/reserve/manage',
			'/reserve/pay',
			'/reserve/pay/done',
			'/ar/reserve',
		]) {
			expect(
				shouldCachePublishedHtml(
					new Request(`https://acme.example${path}`),
					new URL(`https://acme.example${path}`),
					true,
				),
			).toBe(false)
		}
	})
})

describe('experiences pages', () => {
	it('are public catalog pages cached for a minute, never the reserve flow', () => {
		for (const path of [
			'/experiences',
			'/experiences/chefs-counter',
			'/ar/experiences',
		]) {
			expect(isReservationsPage(path)).toBe(false)
			expect(
				shouldCachePublishedHtml(
					new Request(`https://acme.example${path}`),
					new URL(`https://acme.example${path}`),
					true,
				),
			).toBe(true)
		}
	})
})
