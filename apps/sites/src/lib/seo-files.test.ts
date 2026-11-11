import { describe, expect, it } from 'vitest'
import {
	buildLlmsTxt,
	buildRobotsTxt,
	buildSitemapXml,
	formatAddress,
	formatWeeklyHours,
	pagePath,
} from './seo-files'

const origin = 'https://bakery.example'

describe('robots.txt', () => {
	it('points at the sitemap and keeps account and checkout pages out', () => {
		const robots = buildRobotsTxt({ origin, indexable: true })
		expect(robots).toContain('Allow: /\n')
		expect(robots).toContain('Disallow: /menu/checkout')
		expect(robots).toContain('Disallow: /profile')
		expect(robots).toContain('Sitemap: https://bakery.example/sitemap.xml')
	})

	it('closes a host with no published site', () => {
		expect(buildRobotsTxt({ origin, indexable: false })).toBe(
			'User-agent: *\nDisallow: /\n',
		)
	})
})

describe('pagePath', () => {
	it('maps the home page and its legacy slugs to /', () => {
		expect(pagePath('about', true)).toBe('/')
		expect(pagePath('')).toBe('/')
		expect(pagePath('home')).toBe('/')
	})

	it('encodes each segment', () => {
		expect(pagePath('/our story/')).toBe('/our%20story')
		expect(pagePath('events/summer')).toBe('/events/summer')
	})
})

describe('sitemap.xml', () => {
	it('lists each page once, with a date-only lastmod', () => {
		const xml = buildSitemapXml(
			origin,
			[
				{ path: '/', lastModified: '2026-11-01T10:00:00.000Z' },
				{ path: '/menu' },
				{ path: '/menu' },
			],
			{ locales: ['en'], defaultLocale: 'en' },
		)
		expect(xml.match(/<url>/g)).toHaveLength(2)
		expect(xml).toContain('<loc>https://bakery.example/</loc>')
		expect(xml).toContain('<lastmod>2026-11-01</lastmod>')
		expect(xml).not.toContain('xhtml')
	})

	it('lists every language with hreflang alternates', () => {
		const xml = buildSitemapXml(origin, [{ path: '/menu' }], {
			locales: ['ar', 'en'],
			defaultLocale: 'ar',
		})
		expect(xml).toContain('<loc>https://bakery.example/menu</loc>')
		expect(xml).toContain('<loc>https://bakery.example/en/menu</loc>')
		expect(xml).toContain(
			'hreflang="x-default" href="https://bakery.example/menu"',
		)
		expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
	})

	it('escapes XML', () => {
		const xml = buildSitemapXml(`${origin}`, [{ path: '/a&b' }], {
			locales: ['en'],
			defaultLocale: 'en',
		})
		expect(xml).toContain('/a&amp;b')
	})
})

describe('llms.txt helpers', () => {
	it('prefers the formatted address and falls back to its parts', () => {
		expect(formatAddress({ formattedAddress: '1 Main St, Austin, TX' })).toBe(
			'1 Main St, Austin, TX',
		)
		expect(
			formatAddress(
				JSON.stringify({
					streetNumber: '1',
					streetName: 'Main St',
					city: 'Austin',
					state: 'TX',
					postalCode: '78701',
					country: 'US',
				}),
			),
		).toBe('1 Main St, Austin, TX 78701, US')
		expect(formatAddress(null)).toBe('')
	})

	it('writes a week of hours, closed days included', () => {
		const hours = formatWeeklyHours([
			{
				day: 'monday',
				isOpen: true,
				slots: [{ start: '09:00', end: '21:00' }],
			},
			{
				day: 'tuesday',
				isOpen: true,
				slots: [
					{ start: '11:00', end: '14:00' },
					{ start: '17:00', end: '00:00' },
				],
			},
			{ day: 'wednesday', isOpen: false, slots: [] },
		])
		expect(hours[0]).toBe('Monday: 9:00 AM–9:00 PM')
		expect(hours[1]).toBe('Tuesday: 11:00 AM–2:00 PM, 5:00 PM–12:00 AM')
		expect(hours[2]).toBe('Wednesday: Closed')
		expect(hours[6]).toBe('Sunday: Closed')
		expect(formatWeeklyHours('not json')).toEqual([])
	})
})

describe('llms.txt', () => {
	const base = {
		origin,
		name: 'Crumb Bakery',
		description: 'Sourdough and pastries\nbaked daily.',
		currency: 'USD',
		locales: { locales: ['en', 'ar'], defaultLocale: 'en' },
		locations: [
			{
				name: 'Downtown',
				phone: '+1 555 0100',
				address: { formattedAddress: '1 Main St, Austin, TX' },
				storeHours: [
					{
						day: 'monday',
						isOpen: true,
						slots: [{ start: '07:00', end: '15:00' }],
					},
				],
			},
		],
		menu: [
			{
				name: 'Bread',
				items: [
					{ name: 'Sourdough [large]', price: 9 },
					{ name: 'Free taste', price: 0 },
				],
			},
			{ name: 'Empty', items: [] },
		],
		links: [
			{ title: 'Menu and online ordering', path: '/menu' },
			{ title: 'About us', path: '/about', description: 'Our story' },
		],
	}

	it('summarizes the restaurant in Markdown', () => {
		const text = buildLlmsTxt(base)
		expect(
			text.startsWith(
				'# Crumb Bakery\n\n> Sourdough and pastries baked daily.\n',
			),
		).toBe(true)
		expect(text).toContain('Official website: https://bakery.example/')
		expect(text).toContain('Languages: en, ar')
		expect(text).toContain('## Location\n')
		expect(text).toContain('- Address: 1 Main St, Austin, TX')
		expect(text).toContain('- Phone: +1 555 0100')
		expect(text).toContain('  - Monday: 7:00 AM–3:00 PM')
		expect(text).toContain(
			'- [About us](https://bakery.example/about): Our story',
		)
		expect(text).toContain('- Sourdough \\[large\\]: $9.00')
		expect(text).toContain('- Free taste\n')
		expect(text).not.toContain('### Empty')
		expect(text.endsWith('\n')).toBe(true)
	})

	it('names each location when there are several', () => {
		const text = buildLlmsTxt({
			...base,
			locations: [
				base.locations[0]!,
				{ ...base.locations[0]!, name: 'Airport' },
			],
		})
		expect(text).toContain('## Locations')
		expect(text).toContain('### Downtown')
		expect(text).toContain('### Airport')
	})

	it('caps a long menu and points to the full one', () => {
		const items = Array.from({ length: 250 }, (_, i) => ({
			name: `Item ${i}`,
			price: 1,
		}))
		const text = buildLlmsTxt({ ...base, menu: [{ name: 'All', items }] })
		expect(text).toContain('- Item 199:')
		expect(text).not.toContain('- Item 200:')
		expect(text).toContain('The full menu is at https://bakery.example/menu.')
	})
})
