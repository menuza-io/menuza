import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('cloudflare:workers', () => ({
	env: {},
}))

vi.mock('astro:middleware', () => ({
	defineMiddleware: (fn: any) => fn,
}))

vi.mock('~/lib/i18n', () => ({
	createSiteI18n: vi.fn().mockReturnValue({}),
}))

vi.mock('~/lib/org', () => ({
	fetchPublishedOrganizationForHost: vi.fn().mockResolvedValue(null),
	fetchPublishedSitePage: vi.fn().mockResolvedValue(null),
	recordSiteRedirectHit: vi.fn().mockResolvedValue(true),
	recordSiteNotFound: vi.fn().mockResolvedValue(true),
}))

import { onRequest } from './middleware.ts'

describe('Sites middleware onRequest', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		process.env.PUBLIC_SITE_HOST_SUFFIXES = 'sites.localhost,epic-startup.com'
	})

	it('applies security headers and processes static asset requests', async () => {
		const context: any = {
			request: new Request(
				'http://acme.sites.localhost:3008/fonts/inter.woff2',
			),
			locals: {},
		}
		const next = vi
			.fn()
			.mockResolvedValue(new Response('font-data', { status: 200 }))

		const response = (await onRequest(context, next)) as Response

		expect(next).toHaveBeenCalled()
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(response.headers.get('Content-Security-Policy')).toContain(
			"default-src 'self'",
		)
		expect(context.locals.orgSlug).toBe('acme')
	})

	it('attaches no-cache headers to /api/* routes', async () => {
		const context: any = {
			request: new Request('http://acme.sites.localhost:3008/api/auth/session'),
			locals: {},
		}
		const next = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

		const response = (await onRequest(context, next)) as Response

		expect(response.headers.get('Cache-Control')).toBe(
			'no-store, no-cache, must-revalidate',
		)
		expect(response.headers.get('Vary')).toContain('Host')
	})

	it('handles custom domains and sets customHost on locals', async () => {
		const context: any = {
			request: new Request('http://custom-domain.com/_astro/client.js'),
			locals: {},
		}
		const next = vi
			.fn()
			.mockResolvedValue(new Response('console.log()', { status: 200 }))

		const response = (await onRequest(context, next)) as Response

		expect(response.status).toBe(200)
		expect(context.locals.customHost).toBe('custom-domain.com')
		expect(context.locals.orgSlug).toBeNull()
	})

	it('redirects with 301 when configured redirect matches path', async () => {
		const { fetchPublishedOrganizationForHost } = await import('~/lib/org')
		vi.mocked(fetchPublishedOrganizationForHost).mockResolvedValueOnce({
			id: 'org-1',
			name: 'Acme Corp',
			slug: 'acme',
			redirects: [
				{
					id: 'red-1',
					fromPath: '/old-about',
					toPath: '/about',
					statusCode: 301,
				},
			],
		} as any)

		const waitUntilMock = vi.fn()
		const context: any = {
			request: new Request('http://acme.sites.localhost:3008/old-about'),
			locals: {
				cfContext: { waitUntil: waitUntilMock },
			},
		}
		const next = vi.fn()

		const response = (await onRequest(context, next)) as Response

		expect(next).not.toHaveBeenCalled()
		expect(response.status).toBe(301)
		expect(response.headers.get('Location')).toBe('/about')
		expect(waitUntilMock).toHaveBeenCalled()
	})

	it('redirects with 302 and forwards query parameters', async () => {
		const { fetchPublishedOrganizationForHost } = await import('~/lib/org')
		vi.mocked(fetchPublishedOrganizationForHost).mockResolvedValueOnce({
			id: 'org-1',
			name: 'Acme Corp',
			slug: 'acme',
			redirects: [
				{
					id: 'red-2',
					fromPath: '/promo',
					toPath: '/sale',
					statusCode: 302,
				},
			],
		} as any)

		const context: any = {
			request: new Request(
				'http://acme.sites.localhost:3008/promo?ref=newsletter',
			),
			locals: {},
		}
		const next = vi.fn()

		const response = (await onRequest(context, next)) as Response

		expect(next).not.toHaveBeenCalled()
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/sale?ref=newsletter')
	})

	it('rejects scheme-relative redirect targets like //evil.com', async () => {
		const { fetchPublishedOrganizationForHost } = await import('~/lib/org')
		vi.mocked(fetchPublishedOrganizationForHost).mockResolvedValueOnce({
			id: 'org-1',
			name: 'Acme Corp',
			slug: 'acme',
			redirects: [
				{
					id: 'red-evil',
					fromPath: '/trap',
					toPath: '//evil.com',
					statusCode: 301,
				},
			],
		} as any)

		const context: any = {
			request: new Request('http://acme.sites.localhost:3008/trap'),
			locals: {},
		}
		const next = vi
			.fn()
			.mockResolvedValue(new Response('next-handler', { status: 200 }))

		const response = (await onRequest(context, next)) as Response

		expect(next).toHaveBeenCalled()
		expect(response.headers.get('Location')).toBeNull()
	})
})
