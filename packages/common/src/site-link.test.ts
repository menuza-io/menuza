import { describe, expect, it } from 'vitest'
import {
	computeSiteLinkHref,
	formatFileSize,
	matchSitePage,
	normalizeSiteLink,
	resolveSiteLink,
	siteLinkHasDestination,
} from './site-link.ts'

const pages = [
	{ id: 'home', slug: 'home', isHomePage: true },
	{ id: 'about', slug: 'about', isHomePage: false },
]

describe('site-link', () => {
	it('passes through empty values as a URL hash', () => {
		expect(resolveSiteLink(undefined).href).toBe('#')
		expect(resolveSiteLink('').href).toBe('#')
		expect(siteLinkHasDestination('')).toBe(false)
	})

	it('keeps a legacy string URL', () => {
		const resolved = resolveSiteLink('/login')
		expect(resolved.href).toBe('/login')
		expect(resolved.target).toBeUndefined()
	})

	it('builds mailto links with a subject', () => {
		const link = normalizeSiteLink({
			type: 'email',
			email: 'bob@gmail.com',
			subject: "You've got mail!",
		})
		expect(link.href).toBe("mailto:bob@gmail.com?subject=You've%20got%20mail!")
	})

	it('infers email and phone from existing hrefs', () => {
		expect(normalizeSiteLink('mailto:ada@example.com?subject=Hi').type).toBe(
			'email',
		)
		expect(normalizeSiteLink('tel:+14155551212').phone).toBe('+14155551212')
	})

	it('resolves page links against the org page list', () => {
		expect(matchSitePage('/about', pages)?.id).toBe('about')
		expect(matchSitePage('///about///', pages)?.id).toBe('about')
		expect(matchSitePage('/', pages)?.id).toBe('home')
		expect(matchSitePage('/login', pages)).toBeUndefined()
		const withReserved = [
			...pages,
			{ id: 'reserve', slug: 'reserve', isHomePage: false },
			{ id: 'experiences', slug: 'experiences', isHomePage: false },
		]
		expect(matchSitePage('/reserve', withReserved)).toBeUndefined()
		expect(matchSitePage('/experiences', withReserved)).toBeUndefined()

		const about = normalizeSiteLink(
			{ type: 'page', pageId: 'about', pageSlug: 'about' },
			pages,
		)
		expect(computeSiteLinkHref(about, pages)).toBe('/about')

		const home = normalizeSiteLink({ type: 'page', pageId: 'home' }, pages)
		expect(home.href).toBe('/')
	})

	it('opens in a new tab with noopener', () => {
		const resolved = resolveSiteLink({
			type: 'url',
			url: 'https://example.com',
			openIn: 'blank',
		})
		expect(resolved.target).toBe('_blank')
		expect(resolved.rel).toContain('noopener')
		expect(resolved.rel).toContain('noreferrer')
	})

	it('adds prefetch to rel when requested', () => {
		const resolved = resolveSiteLink({
			type: 'url',
			url: '/about',
			preload: 'prefetch',
		})
		expect(resolved.rel).toBe('prefetch')
	})

	it('uses the file url as the href', () => {
		const resolved = resolveSiteLink({
			type: 'file',
			file: {
				url: '/resources/images?objectKey=menu.pdf',
				name: 'menu.pdf',
				size: 919,
			},
		})
		expect(resolved.href).toBe('/resources/images?objectKey=menu.pdf')
		expect(siteLinkHasDestination(resolved.href)).toBe(true)
	})

	it('formats file sizes the way the inspector shows them', () => {
		expect(formatFileSize(919)).toBe('919 B')
		expect(formatFileSize(1024)).toBe('1 KB')
		expect(formatFileSize(15360)).toBe('15 KB')
	})
})
