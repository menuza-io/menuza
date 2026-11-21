import { describe, expect, test } from 'vitest'
import {
	findOwnSiteLinks,
	isShortLinkCode,
	ownSitePath,
	sanitizeAttributionValue,
	shortLinkLocation,
	shortLinkUrl,
	siteTargetPathSchema,
	tagOwnSiteLinksInHtml,
	tagOwnSiteLinksInText,
	utmSlug,
} from './short-links.ts'

const SITE = 'https://casa-verde.menuza.site'

describe('site target paths', () => {
	test.each(['/', '/menu', '/menu?item=abc&x=1', '/events/spring-brunch'])(
		'%s is a path on the site',
		(path) => {
			expect(siteTargetPathSchema.safeParse(path).success).toBe(true)
		},
	)

	test.each([
		'https://evil.example/phish',
		'//evil.example',
		'http://casa-verde.menuza.site/menu',
		'menu',
		'/\\evil.example',
		'/menu#frag',
		'javascript:alert(1)',
		'',
		`/${'a'.repeat(250)}`,
	])('%j is refused (an external domain cannot be a target)', (path) => {
		expect(siteTargetPathSchema.safeParse(path).success).toBe(false)
	})
})

describe('codes and urls', () => {
	test('a code is 7 characters of the unambiguous alphabet', () => {
		expect(isShortLinkCode('k7m2p9x')).toBe(true)
		for (const bad of [
			'k7m2p9',
			'k7m2p9xx',
			'K7M2P9X',
			'k7m2p9o',
			'k7m2p91',
			'',
			null,
		]) {
			expect(isShortLinkCode(bad)).toBe(false)
		}
	})

	test('the short URL is on the site and may carry a message id', () => {
		expect(shortLinkUrl(`${SITE}/`, 'k7m2p9x')).toBe(`${SITE}/l/k7m2p9x`)
		expect(shortLinkUrl(SITE, 'k7m2p9x', 'abc-123-def')).toBe(
			`${SITE}/l/k7m2p9x?m=abc-123-def`,
		)
	})
})

describe('shortLinkLocation', () => {
	test('adds the UTM values and the ids to the stored path', () => {
		const location = shortLinkLocation({
			targetPath: '/menu?item=abc',
			utmSource: 'menuza',
			utmMedium: 'sms',
			utmCampaign: 'taco-tuesday',
			campaignId: 'camp-1',
			stepId: 'node-2',
			linkId: 'link-9',
		})
		const url = new URL(`${SITE}${location}`)
		expect(url.pathname).toBe('/menu')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			item: 'abc',
			utm_source: 'menuza',
			utm_medium: 'sms',
			utm_campaign: 'taco-tuesday',
			mzc: 'camp-1',
			mzs: 'node-2',
			mzl: 'link-9',
		})
	})

	test('never overrides a value the path already has', () => {
		const location = shortLinkLocation({
			targetPath: '/?utm_source=poster',
			utmSource: 'menuza',
			linkId: 'l1',
		})!
		expect(new URL(`${SITE}${location}`).searchParams.get('utm_source')).toBe(
			'poster',
		)
	})

	test('a stored target that is not a site path redirects nowhere', () => {
		expect(
			shortLinkLocation({ targetPath: 'https://evil.example', linkId: 'l1' }),
		).toBeNull()
		expect(
			shortLinkLocation({ targetPath: '//evil.example', linkId: 'l1' }),
		).toBeNull()
	})

	test('values are stripped of control characters and capped at 100', () => {
		const location = shortLinkLocation({
			targetPath: '/',
			utmCampaign: `a\u0000b\nc${'x'.repeat(200)}`,
			linkId: 'l1',
		})!
		const value = new URL(`${SITE}${location}`).searchParams.get(
			'utm_campaign',
		)!
		expect(value.length).toBe(100)
		expect(value.startsWith('abcx')).toBe(true)
	})
})

describe('own-site links', () => {
	test('only the own origin counts', () => {
		expect(ownSitePath(`${SITE}/menu?x=1`, SITE)).toBe('/menu?x=1')
		expect(ownSitePath('https://evil.example/menu', SITE)).toBeNull()
		expect(
			ownSitePath('https://casa-verde.menuza.site.evil.example/', SITE),
		).toBeNull()
		expect(ownSitePath('ftp://casa-verde.menuza.site/', SITE)).toBeNull()
		expect(ownSitePath('not a url', SITE)).toBeNull()
	})

	test('finds links in a text and ignores closing punctuation', () => {
		const found = findOwnSiteLinks(
			`Order now ${SITE}/menu, or see https://other.example/x. Also ${SITE}/events!`,
			SITE,
		)
		expect(found.map((link) => link.path)).toEqual(['/menu', '/events'])
	})

	test('tags text links and leaves other URLs alone', () => {
		const out = tagOwnSiteLinksInText(
			`Order ${SITE}/menu. Maps: https://maps.example/p`,
			SITE,
			{ mzc: 'camp-1', utm_medium: 'sms' },
		)
		expect(out).toBe(
			`Order ${SITE}/menu?mzc=camp-1&utm_medium=sms. Maps: https://maps.example/p`,
		)
	})

	test('tags every own-site href of an html email, in both quote styles', () => {
		const html = `<a href="${SITE}/menu?item=1&amp;x=2">Order</a> <a class="b" href='${SITE}/'>Home</a> <a href="https://other.example/x">Other</a>`
		const out = tagOwnSiteLinksInHtml(html, SITE, {
			mzc: 'camp-1',
			utm_medium: 'email',
		})
		expect(out).toContain(
			`href="${SITE}/menu?item=1&amp;x=2&amp;mzc=camp-1&amp;utm_medium=email"`,
		)
		expect(out).toContain(`href='${SITE}/?mzc=camp-1&amp;utm_medium=email'`)
		expect(out).toContain('href="https://other.example/x"')
	})
})

describe('values', () => {
	test('sanitizeAttributionValue', () => {
		expect(sanitizeAttributionValue('  hello\u0007 ')).toBe('hello')
		expect(sanitizeAttributionValue('')).toBeNull()
		expect(sanitizeAttributionValue(5)).toBeNull()
		expect(sanitizeAttributionValue('x'.repeat(500))).toHaveLength(100)
	})

	test('utmSlug', () => {
		expect(utmSlug('Taco Tuesday! 50% off')).toBe('taco-tuesday-50-off')
		expect(utmSlug('')).toBeNull()
		expect(utmSlug('—')).toBeNull()
	})
})
