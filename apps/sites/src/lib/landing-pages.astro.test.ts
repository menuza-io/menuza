/**
 * Renders the generated pages (#137, #184) and the home page's verification
 * tags (#138) with Astro's container, with the App's public endpoints mocked.
 * Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSiteI18n } from '~/lib/i18n'
import RenderBlocks from '../components/blocks/RenderBlocks.astro'
import AreaPage from '../pages/delivery/[area].astro'
import EventPage from '../pages/events/[slug].astro'
import HomePage from '../pages/index.astro'
import LocationPage from '../pages/locations/[slug].astro'
import DishPage from '../pages/menu/[dish].astro'

const org = vi.hoisted(() => ({
	fetchPublishedLanding: vi.fn(),
	fetchPublishedSiteMenu: vi.fn(),
	fetchPublishedReservations: vi.fn(),
	fetchPublishedEvents: vi.fn(),
	fetchPublishedSitePage: vi.fn(),
	fetchPublishedLoyalty: vi.fn(),
}))
vi.mock('~/lib/org', () => org)
vi.mock('varlock/env', () => ({ ENV: {} }))

const organization = {
	id: 'org_1',
	name: 'Al Bait',
	slug: 'albait',
	locales: ['en', 'ar'],
	defaultLocale: 'en',
	cuisines: ['lebanese'],
	priceRange: '﷼﷼',
	siteVerification: { google: ['AbC_123-xyz987'], bing: null },
	theme: {
		css: '',
		mode: 'light',
		baseColor: 'neutral',
		theme: 'default',
		radius: '0.5',
	},
}

const location = (id: string, slug: string) => ({
	id,
	slug,
	name: `{"en":"${slug}","ar":"العليا"}`,
	phone: '+966 11 555 0100',
	address: { city: 'Riyadh', streetName: 'Olaya St', lat: 24.7, lng: 46.68 },
	storeHours: [
		{ day: 'monday', isOpen: true, slots: [{ start: '09:00', end: '22:00' }] },
		{ day: 'tuesday', isOpen: true, slots: [{ start: '09:00', end: '22:00' }] },
	],
	specialHours: [],
	timezone: 'Asia/Riyadh',
	fulfillmentOptions: { pickup: true, delivery: true },
	isDefault: id === 'l1',
	intro: '{"en":"Our first branch.","ar":"فرعنا الأول."}',
	seoTitle: null,
	seoDescription: null,
	cuisines: ['lebanese'],
	priceRange: 2,
	updatedAt: '2026-11-01T00:00:00.000Z',
})

const menu = {
	organization: {
		id: 'org_1',
		name: 'Al Bait',
		slug: 'albait',
		currency: 'SAR',
		defaultLocale: 'en',
		locales: ['en', 'ar'],
	},
	locations: [
		{
			id: 'l1',
			name: 'olaya',
			isDefault: true,
			phone: null,
			address: {},
			storeHours: [],
		},
	],
	menus: [
		{
			id: 'm',
			categories: [
				{
					id: 'c',
					displayName: 'Wraps',
					items: [
						{
							id: 'i1',
							displayName: 'Falafel wrap',
							description: 'Crispy',
							price: 18,
							imageUrl: null,
							isPopular: true,
							availabilityStatus: 'available',
							dietaryTags: ['vegan'],
						},
						{
							id: 'i2',
							displayName: 'Secret',
							price: 9,
							imageUrl: null,
							availabilityStatus: 'hidden',
						},
					],
				},
			],
		},
	],
}

const landing = {
	features: {
		locationPages: true,
		dishPages: true,
		areaPages: true,
		events: true,
	},
	locations: [location('l1', 'olaya'), location('l2', 'malqa')],
	goneLocationSlugs: ['closed'],
	dishes: [
		{ id: 'i1', slug: 'falafel-wrap' },
		{ id: 'i2', slug: 'secret' },
	],
	areas: [
		{
			slug: 'thin',
			noIndex: true,
			locationId: 'l1',
			locationSlug: 'olaya',
			zoneId: 'z',
			name: 'Al Malqa',
			minimumOrder: 30,
			deliveryFee: 9,
			intro: null,
		},
	],
}

async function render(
	component: unknown,
	options: { path: string; params: Record<string, string>; locale?: string },
) {
	const container = await AstroContainer.create()
	const locale = options.locale ?? 'en'
	return container.renderToResponse(component as never, {
		request: new Request(`https://albait.example${options.path}`),
		params: options.params,
		locals: {
			organization,
			orgSlug: 'albait',
			customHost: null,
			requestedLocale: locale,
			defaultLocale: 'en',
			i18n: createSiteI18n(locale),
		} as never,
	})
}

beforeEach(() => {
	org.fetchPublishedLanding.mockResolvedValue(landing)
	org.fetchPublishedSiteMenu.mockResolvedValue(menu)
	org.fetchPublishedReservations.mockResolvedValue({ online: true })
	org.fetchPublishedSitePage.mockResolvedValue(null)
	org.fetchPublishedLoyalty.mockResolvedValue(null)
	org.fetchPublishedEvents.mockResolvedValue(null)
})

function jsonLd(html: string) {
	const match =
		/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)
	return match ? JSON.parse(match[1]!) : null
}

describe('location page (#137)', () => {
	it('shows hours, directions, order and book buttons, and its own Restaurant data', async () => {
		const response = await render(LocationPage, {
			path: '/locations/olaya',
			params: { slug: 'olaya' },
		})
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('Our first branch.')
		expect(html).toContain('data-hours')
		expect(html).toMatch(/Monday[\s\S]*9:00\s?AM–10:00\s?PM/)
		expect(html).toContain(
			'href="https://www.google.com/maps/dir/?api=1&amp;destination=24.7,46.68"',
		)
		expect(html).toContain('href="/menu?location=l1" data-action="order"')
		expect(html).toContain('href="/reserve" data-action="reserve"')
		expect(html).toContain(
			'<title>Al Bait olaya – Lebanese restaurant in Riyadh</title>',
		)
		expect(html).toContain(
			'hreflang="ar" href="https://albait.example/ar/locations/olaya"',
		)
		expect(jsonLd(html)).toMatchObject({
			'@type': 'Restaurant',
			url: 'https://albait.example/locations/olaya',
			servesCuisine: 'Lebanese',
			priceRange: '﷼﷼',
			telephone: '+966 11 555 0100',
		})
	})

	it('is in Arabic on the Arabic site', async () => {
		const response = await render(LocationPage, {
			path: '/ar/locations/olaya',
			params: { slug: 'olaya' },
			locale: 'ar',
		})
		const html = await response.text()
		expect(html).toContain('lang="ar" dir="rtl"')
		expect(html).toContain('فرعنا الأول.')
		expect(html).toContain('الاثنين')
		expect(html).toContain('اطلب عبر الإنترنت')
		expect(html).toContain('href="/ar/menu?location=l1"')
		expect(html).toContain('مطعم لبناني في Riyadh')
	})

	it('answers 410 for a deactivated location and 404 for an unknown one', async () => {
		expect(
			(
				await render(LocationPage, {
					path: '/locations/closed',
					params: { slug: 'closed' },
				})
			).status,
		).toBe(410)
		expect(
			(
				await render(LocationPage, {
					path: '/locations/nope',
					params: { slug: 'nope' },
				})
			).status,
		).toBe(404)
	})
})

describe('dish page (#137)', () => {
	it('publishes an enabled dish with MenuItem data, and 404s a hidden one', async () => {
		const response = await render(DishPage, {
			path: '/menu/falafel-wrap',
			params: { dish: 'falafel-wrap' },
		})
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('href="/menu?item=i1" data-action="order"')
		expect(jsonLd(html)).toMatchObject({
			'@type': 'MenuItem',
			name: 'Falafel wrap',
			offers: { price: '18.00', priceCurrency: 'SAR' },
		})
		expect(
			(
				await render(DishPage, {
					path: '/menu/secret',
					params: { dish: 'secret' },
				})
			).status,
		).toBe(404)
	})
})

describe('area page (#137)', () => {
	it('is noindex without an introduction', async () => {
		const response = await render(AreaPage, {
			path: '/delivery/thin',
			params: { area: 'thin' },
		})
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
		expect(html).toContain('Delivery to Al Malqa')
	})
})

describe('event page (#184)', () => {
	const event = (phase: string) => ({
		events: [
			{
				slug: 'trivia',
				title: 'Trivia night',
				description: 'Teams of four.',
				imageUrl: null,
				link: null,
				experience: null,
				location: { name: 'Olaya', slug: 'olaya', address: { city: 'Riyadh' } },
				timezone: 'America/New_York',
				phase,
				lastEndsAt: null,
				occurrences:
					phase === 'upcoming'
						? [
								{
									date: '2026-11-03',
									start: '2026-11-03T20:00:00-05:00',
									end: '2026-11-03T22:00:00-05:00',
									startMs: Date.parse('2026-11-04T01:00:00Z'),
									endMs: Date.parse('2026-11-04T03:00:00Z'),
								},
							]
						: [],
				updatedAt: '2026-11-01T00:00:00.000Z',
			},
		],
	})

	it('has Event data, local times and an Add to calendar file', async () => {
		org.fetchPublishedEvents.mockResolvedValue(event('upcoming'))
		const response = await render(EventPage, {
			path: '/events/trivia',
			params: { slug: 'trivia' },
		})
		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toMatch(/Tue, Nov 3 · 8:00\s?PM – 10:00\s?PM/)
		expect(html).toContain('href="/events/trivia.ics"')
		expect(jsonLd(html)).toMatchObject({
			'@type': 'Event',
			startDate: '2026-11-03T20:00:00-05:00',
			location: { '@type': 'Place', name: 'Olaya' },
		})
	})

	it('says a finished event ended (noindex), then answers 410', async () => {
		org.fetchPublishedEvents.mockResolvedValue(event('ended'))
		const ended = await render(EventPage, {
			path: '/events/trivia',
			params: { slug: 'trivia' },
		})
		const html = await ended.text()
		expect(ended.status).toBe(200)
		expect(html).toContain('This event has ended.')
		expect(html).toContain('noindex')
		org.fetchPublishedEvents.mockResolvedValue(event('gone'))
		expect(
			(
				await render(EventPage, {
					path: '/events/trivia',
					params: { slug: 'trivia' },
				})
			).status,
		).toBe(410)
	})
})

describe('home page (#138)', () => {
	it('carries the Google verification meta tag', async () => {
		const response = await render(HomePage, { path: '/', params: {} })
		const html = await response.text()
		expect(html).toContain(
			'<meta name="google-site-verification" content="AbC_123-xyz987">',
		)
		expect(jsonLd(html)).toMatchObject({
			servesCuisine: 'Lebanese',
			priceRange: '﷼﷼',
		})
	})
})

describe('Upcoming events section (#184)', () => {
	it('renders the next events on any page, and nothing while there are none', async () => {
		const upcoming = (slug: string) => ({
			slug,
			title: slug,
			description: '',
			imageUrl: null,
			link: null,
			experience: null,
			location: null,
			timezone: 'Asia/Riyadh',
			phase: 'upcoming',
			lastEndsAt: null,
			occurrences: [
				{
					date: '2026-12-01',
					start: '2026-12-01T20:00:00+03:00',
					end: '2026-12-01T22:00:00+03:00',
					startMs: Date.parse('2026-12-01T17:00:00Z'),
					endMs: Date.parse('2026-12-01T19:00:00Z'),
				},
			],
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		org.fetchPublishedEvents.mockResolvedValue({
			events: ['a', 'b', 'c', 'd'].map(upcoming),
		})
		const container = await AstroContainer.create()
		const locals = {
			organization,
			orgSlug: 'albait',
			customHost: null,
			requestedLocale: 'en',
			defaultLocale: 'en',
			i18n: createSiteI18n('en'),
		} as never
		const html = await container.renderToString(RenderBlocks as never, {
			props: {
				sections: [
					{
						id: 's1',
						type: 'events',
						position: 1,
						config: { heading: 'This week', count: 3 },
					},
				],
			},
			locals,
		})
		expect(html).toContain('This week')
		expect(html.match(/data-event="/g)).toHaveLength(3)
		expect(html).toContain('href="/events"')
		org.fetchPublishedEvents.mockResolvedValue(null)
		const empty = await container.renderToString(RenderBlocks as never, {
			props: {
				sections: [{ id: 's1', type: 'events', position: 1, config: {} }],
			},
			locals,
		})
		expect(empty).not.toContain('data-events-block')
	})
})
