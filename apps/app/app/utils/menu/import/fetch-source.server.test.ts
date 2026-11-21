import { describe, expect, it, vi } from 'vitest'
import {
	extractHtmlMenuTextAndImages,
	fetchMenuSource,
	validateMenuImportUrl,
} from './fetch-source.server.ts'

describe('menu import SSRF & source fetch (#73)', () => {
	it('refuses non-HTTPS schemes and URLs with embedded credentials', async () => {
		const resolve = vi.fn().mockResolvedValue(['93.184.216.34'])

		for (const bad of [
			'http://example.com/menu',
			'ftp://example.com/menu.pdf',
			'file:///etc/passwd',
			'javascript:alert(1)',
			'https://user:pass@example.com/menu',
		]) {
			const res = await validateMenuImportUrl(bad, resolve)
			expect(res.ok).toBe(false)
			if (!res.ok) expect(res.error).toBe('url_not_allowed')
		}
		expect(resolve).not.toHaveBeenCalled()
	})

	it('refuses private, loopback, link-local, IPv6, and IPv4-mapped IPv6 literals and DNS answers', async () => {
		const directPrivate = [
			'https://127.0.0.1/menu',
			'https://10.0.0.5/menu',
			'https://172.16.0.1/menu',
			'https://192.168.1.10/menu',
			'https://169.254.169.254/latest/meta-data',
			'https://localhost/menu',
			'https://menu.local/menu',
			'https://service.internal/menu',
			'https://[::1]/menu',
			'https://[fe80::1]/menu',
			'https://[fc00::1]/menu',
			'https://[::ffff:127.0.0.1]/menu',
			'https://[::ffff:169.254.169.254]/menu',
		]

		for (const target of directPrivate) {
			const res = await validateMenuImportUrl(target, async () => [])
			expect(res.ok).toBe(false)
			if (!res.ok) expect(res.error).toBe('url_not_allowed')
		}

		// Domain resolving to private / loopback / mapped IPv6 must also be refused.
		for (const ip of [
			'127.0.0.1',
			'10.1.2.3',
			'169.254.169.254',
			'::1',
			'fe80::1',
			'::ffff:10.0.0.1',
		]) {
			const res = await fetchMenuSource('https://rebind.example.com/menu', {
				resolve: async () => [ip],
				fetch: vi.fn(),
			})
			expect(res.ok).toBe(false)
			if (!res.ok) expect(res.error).toBe('url_not_allowed')
		}
	})

	it('re-checks every redirect hop and refuses redirect to private address or http', async () => {
		const resolve = vi.fn(async (host: string) => {
			if (host === 'public.example.com') return ['93.184.216.34']
			if (host === 'internal-hop.example.com') return ['127.0.0.1']
			return []
		})

		const fetchRedirectToPrivate = vi.fn(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: 'https://internal-hop.example.com/secret' },
			})
		})

		const res1 = await fetchMenuSource('https://public.example.com/menu', {
			resolve,
			fetch: fetchRedirectToPrivate,
		})
		expect(res1.ok).toBe(false)
		if (!res1.ok) expect(res1.error).toBe('url_not_allowed')
		expect(fetchRedirectToPrivate).toHaveBeenCalledTimes(1)

		const fetchRedirectToHttp = vi.fn(async () => {
			return new Response(null, {
				status: 301,
				headers: { location: 'http://public.example.com/menu' },
			})
		})
		const res2 = await fetchMenuSource('https://public.example.com/menu', {
			resolve,
			fetch: fetchRedirectToHttp,
		})
		expect(res2.ok).toBe(false)
		if (!res2.ok) expect(res2.error).toBe('url_not_allowed')
	})

	it('allows public HTML and PDF responses and refuses unsupported content-types', async () => {
		const resolve = async () => ['93.184.216.34']

		const htmlRes = await fetchMenuSource('https://menu.example.com/', {
			resolve,
			fetch: async () =>
				new Response('<html><body><h1>Burger</h1><p>$12</p></body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				}),
		})
		expect(htmlRes.ok).toBe(true)
		if (htmlRes.ok && htmlRes.kind === 'html') {
			expect(htmlRes.html).toContain('Burger')
		}

		const pdfRes = await fetchMenuSource('https://menu.example.com/menu.pdf', {
			resolve,
			fetch: async () =>
				new Response(new TextEncoder().encode('%PDF-1.4\n...'), {
					status: 200,
					headers: { 'content-type': 'application/pdf' },
				}),
		})
		expect(pdfRes.ok).toBe(true)
		if (pdfRes.ok) expect(pdfRes.kind).toBe('pdf')

		const jsonRes = await fetchMenuSource('https://menu.example.com/api.json', {
			resolve,
			fetch: async () =>
				new Response('{"ok":true}', {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		})
		expect(jsonRes.ok).toBe(false)
		if (!jsonRes.ok) expect(jsonRes.error).toBe('unsupported_file')
	})

	it('enforces 10 MB body cap and timeout cap', async () => {
		const resolve = async () => ['93.184.216.34']

		const tooLargeHeader = await fetchMenuSource('https://menu.example.com/', {
			resolve,
			maxBytes: 1024,
			fetch: async () =>
				new Response('tiny', {
					status: 200,
					headers: {
						'content-type': 'text/html',
						'content-length': '2048',
					},
				}),
		})
		expect(tooLargeHeader.ok).toBe(false)
		if (!tooLargeHeader.ok) expect(tooLargeHeader.error).toBe('fetch_failed')

		const tooLargeStream = await fetchMenuSource('https://menu.example.com/', {
			resolve,
			maxBytes: 10,
			fetch: async () =>
				new Response('<html><body>12345678901234567890</body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' },
				}),
		})
		expect(tooLargeStream.ok).toBe(false)
		if (!tooLargeStream.ok) expect(tooLargeStream.error).toBe('fetch_failed')

		const timedOut = await fetchMenuSource('https://menu.example.com/', {
			resolve,
			timeoutMs: 10,
			fetch: (_url, init) =>
				new Promise((_res, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new Error('Aborted'))
					})
				}),
		})
		expect(timedOut.ok).toBe(false)
		if (!timedOut.ok) expect(timedOut.error).toBe('fetch_failed')
	})

	it('extracts readable HTML text and public HTTPS image suggestions only', () => {
		const html = `
			<html>
				<head>
					<title>Bistro Menu</title>
					<meta property="og:image" content="https://cdn.example.com/hero.jpg" />
					<script>window.__SECRET__ = "ignore";</script>
				</head>
				<body>
					<h1>Mains</h1>
					<p>Truffle Pasta - $18</p>
					<img src="/images/pasta.png" alt="Truffle Pasta" />
					<img src="http://insecure.example.com/bad.png" alt="Insecure" />
					<img src="https://127.0.0.1/internal.png" alt="Private" />
					<img src="data:image/png;base64,AAAA" alt="Inline" />
				</body>
			</html>
		`
		const out = extractHtmlMenuTextAndImages(
			html,
			'https://bistro.example.com/menu',
		)
		expect(out.title).toBe('Bistro Menu')
		expect(out.text).toContain('Truffle Pasta - $18')
		expect(out.text).not.toContain('__SECRET__')
		expect(out.imageSuggestions).toEqual([
			{ url: 'https://cdn.example.com/hero.jpg', alt: 'Bistro Menu' },
			{
				url: 'https://bistro.example.com/images/pasta.png',
				alt: 'Truffle Pasta',
			},
		])
	})
})
