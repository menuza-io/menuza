import { describe, expect, it, vi } from 'vitest'
import {
	createClickLimiter,
	isLikelyBot,
	lookupShortLink,
	safeLocation,
} from './short-links'
import {
	isSitesAppRoute,
	isSitesShortLinkRoute,
	shouldCachePublishedHtml,
} from './site-headers'

const base = {
	tenantApiUrl: 'https://tenant.example',
	origin: 'https://casa-verde.menuza.site',
	code: 'k7m2p9x',
	count: true,
}

function answers(body: unknown, status = 200) {
	return vi.fn(async () =>
		Response.json(body, { status }),
	) as unknown as typeof fetch
}

describe('lookupShortLink', () => {
	it('asks the region with the site origin and the code, and nothing about the visitor', async () => {
		const fetchImpl = answers({
			status: 'ok',
			location: '/menu?utm_source=x&mzl=l1',
		})
		const result = await lookupShortLink({
			...base,
			messageId: '11111111-2222-3333-4444-555555555555',
			slug: 'casa-verde',
			fetchImpl,
		})
		expect(result).toEqual({
			status: 'ok',
			location: '/menu?utm_source=x&mzl=l1',
		})
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
		const parsed = new URL(String(url))
		expect(parsed.origin + parsed.pathname).toBe(
			'https://tenant.example/short-links/resolve',
		)
		expect(Object.fromEntries(parsed.searchParams)).toEqual({
			code: 'k7m2p9x',
			m: '11111111-2222-3333-4444-555555555555',
			slug: 'casa-verde',
		})
		// Only Accept and Origin: no user agent, address or cookie is forwarded.
		expect(
			Object.keys(
				(init as RequestInit).headers as Record<string, string>,
			).sort(),
		).toEqual(['Accept', 'Origin'])
	})

	it('asks not to count when the visit is a bot or over the limit', async () => {
		const fetchImpl = answers({ status: 'ok', location: '/' })
		await lookupShortLink({ ...base, count: false, fetchImpl })
		expect(
			new URL(String(vi.mocked(fetchImpl).mock.calls[0]![0])).searchParams.get(
				'count',
			),
		).toBe('0')
	})

	it('maps a disabled link, an unknown one and an outage', async () => {
		expect(
			await lookupShortLink({
				...base,
				fetchImpl: answers({ status: 'disabled' }),
			}),
		).toEqual({
			status: 'disabled',
		})
		expect(
			await lookupShortLink({
				...base,
				fetchImpl: answers({ status: 'not_found' }, 404),
			}),
		).toEqual({ status: 'not_found' })
		expect(
			await lookupShortLink({ ...base, fetchImpl: answers({}, 503) }),
		).toEqual({
			status: 'unavailable',
		})
		const down = vi.fn(async () => {
			throw new Error('network')
		}) as unknown as typeof fetch
		expect(await lookupShortLink({ ...base, fetchImpl: down })).toEqual({
			status: 'unavailable',
		})
	})

	it('never follows a location that leaves the site', async () => {
		for (const location of [
			'https://evil.example/',
			'//evil.example',
			'/\\evil.example',
			'menu',
			null,
		]) {
			expect(
				await lookupShortLink({
					...base,
					fetchImpl: answers({ status: 'ok', location }),
				}),
			).toEqual({ status: 'unavailable' })
		}
		expect(safeLocation('/menu?x=1')).toBe('/menu?x=1')
		expect(safeLocation('//evil.example')).toBeNull()
	})

	it('a malformed code never reaches the network', async () => {
		const fetchImpl = answers({ status: 'ok', location: '/' })
		expect(
			await lookupShortLink({ ...base, code: 'NOPE!', fetchImpl }),
		).toEqual({
			status: 'not_found',
		})
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

describe('bots and the per-address limit', () => {
	it.each([
		'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
		'facebookexternalhit/1.1',
		'WhatsApp/2.23',
		'Slackbot-LinkExpanding 1.0',
		'curl/8.4.0',
		'Twitterbot/1.0',
		'',
		null,
	])('%j is not counted', (agent) => {
		expect(isLikelyBot(agent)).toBe(true)
	})

	it('a phone browser is counted', () => {
		expect(
			isLikelyBot(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
			),
		).toBe(false)
	})

	it('allows 3 visits a minute per address and forgets the minute after', () => {
		let now = 0
		const limiter = createClickLimiter({
			limit: 3,
			windowMs: 60_000,
			now: () => now,
		})
		expect([1, 2, 3, 4].map(() => limiter.allow('203.0.113.9'))).toEqual([
			true,
			true,
			true,
			false,
		])
		expect(limiter.allow('203.0.113.10')).toBe(true)
		now = 61_000
		expect(limiter.allow('203.0.113.9')).toBe(true)
		// No address, nothing to limit on.
		expect(limiter.allow(null)).toBe(true)
	})

	it('keeps a bounded number of addresses in memory', () => {
		const limiter = createClickLimiter({
			limit: 1,
			windowMs: 60_000,
			maxKeys: 3,
		})
		for (let i = 0; i < 10; i++) limiter.allow(`10.0.0.${i}`)
		// The earliest address was dropped, so it is allowed again.
		expect(limiter.allow('10.0.0.0')).toBe(true)
	})
})

describe('routing', () => {
	it('/l/<code> is a generated route, never a CMS page, and never cached', () => {
		expect(isSitesShortLinkRoute('/l/k7m2p9x')).toBe(true)
		expect(isSitesShortLinkRoute('/ladies')).toBe(false)
		expect(isSitesAppRoute('/l/k7m2p9x')).toBe(true)
		expect(
			shouldCachePublishedHtml(
				new Request('https://casa-verde.menuza.site/l/k7m2p9x'),
				new URL('https://casa-verde.menuza.site/l/k7m2p9x'),
				true,
			),
		).toBe(false)
	})
})
