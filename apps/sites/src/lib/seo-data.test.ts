import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSiteSeoData } from './seo-data'
import { buildLlmsTxt, buildSitemapXml } from './seo-files'

const org = vi.hoisted(() => ({
	fetchPublishedSitePages: vi.fn(),
	fetchPublishedSiteMenu: vi.fn(),
	fetchPublishedReservations: vi.fn(),
	fetchPublishedCareers: vi.fn(),
	fetchPublishedDrops: vi.fn(),
	fetchPublishedLanding: vi.fn(),
	fetchPublishedEvents: vi.fn(),
}))
vi.mock('~/lib/org', () => org)

const location = (
	id: string,
	slug: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	slug,
	name: slug,
	phone: null,
	address: { city: 'Riyadh' },
	storeHours: null,
	specialHours: null,
	timezone: 'Asia/Riyadh',
	fulfillmentOptions: null,
	isDefault: false,
	intro: null,
	seoTitle: null,
	seoDescription: null,
	cuisines: ['lebanese'],
	priceRange: 2,
	updatedAt: '2026-11-01T00:00:00.000Z',
	...extra,
})

const event = (slug: string, phase: string, occurrences = 1) => ({
	slug,
	title: slug,
	description: '',
	imageUrl: null,
	link: null,
	experience: null,
	location: null,
	timezone: 'Asia/Riyadh',
	phase,
	lastEndsAt: null,
	occurrences: Array.from({ length: occurrences }, () => ({
		date: '2026-12-01',
		start: '2026-12-01T20:00:00+03:00',
		end: '2026-12-01T22:00:00+03:00',
		startMs: 0,
		endMs: 0,
	})),
	updatedAt: '2026-11-02T00:00:00.000Z',
})

const organization = {
	id: 'o',
	name: 'Al Bait',
	slug: 'albait',
	locales: ['en', 'ar'],
	defaultLocale: 'en',
	cuisines: ['lebanese', 'shawarma'],
	priceRange: '﷼﷼',
}

beforeEach(() => {
	org.fetchPublishedSitePages.mockResolvedValue([])
	org.fetchPublishedSiteMenu.mockResolvedValue({
		organization: { name: 'Al Bait', currency: 'SAR' },
		locations: [
			{
				id: 'l1',
				name: 'olaya',
				phone: null,
				address: { city: 'Riyadh' },
				storeHours: null,
			},
		],
		menus: [
			{
				categories: [
					{
						displayName: 'Wraps',
						items: [
							{
								id: 'i1',
								displayName: 'Falafel',
								price: 18,
								availabilityStatus: 'available',
							},
							{
								id: 'i2',
								displayName: 'Secret',
								price: 9,
								availabilityStatus: 'hidden',
							},
						],
					},
				],
			},
		],
	})
	org.fetchPublishedReservations.mockResolvedValue(null)
	org.fetchPublishedCareers.mockResolvedValue(null)
	org.fetchPublishedDrops.mockResolvedValue([])
	org.fetchPublishedLanding.mockResolvedValue({
		features: {
			locationPages: true,
			dishPages: true,
			areaPages: true,
			events: true,
		},
		locations: [
			location('l1', 'olaya', { cuisines: ['sushi'], priceRange: 4 }),
			location('l2', 'malqa'),
		],
		goneLocationSlugs: ['closed-branch'],
		dishes: [
			{ id: 'i1', slug: 'falafel' },
			{ id: 'i2', slug: 'secret' },
		],
		areas: [
			{
				slug: 'al-malqa',
				noIndex: false,
				locationId: 'l1',
				locationSlug: 'olaya',
				zoneId: 'z1',
				name: 'Al Malqa',
				minimumOrder: 0,
				deliveryFee: 0,
				intro: '{"en":"Hi"}',
			},
			{
				slug: 'thin',
				noIndex: true,
				locationId: 'l1',
				locationSlug: 'olaya',
				zoneId: 'z2',
				name: 'Thin',
				minimumOrder: 0,
				deliveryFee: 0,
				intro: null,
			},
		],
	})
	org.fetchPublishedEvents.mockResolvedValue({
		events: [event('trivia', 'upcoming'), event('old-brunch', 'ended', 0)],
	})
})

describe('loadSiteSeoData: generated pages and events', () => {
	it('lists location, dish, indexable area and upcoming event pages once', async () => {
		const data = await loadSiteSeoData(organization as never, {
			slug: 'albait',
			host: null,
		})
		const paths = data.sitemap.map((entry) => entry.path)
		expect(paths).toEqual(
			expect.arrayContaining([
				'/locations',
				'/locations/olaya',
				'/locations/malqa',
				'/menu/falafel',
				'/delivery/al-malqa',
				'/events',
				'/events/trivia',
			]),
		)
		// A deactivated location, a hidden dish, a thin area and a finished event stay out.
		for (const path of [
			'/locations/closed-branch',
			'/menu/secret',
			'/delivery/thin',
			'/events/old-brunch',
		]) {
			expect(paths).not.toContain(path)
		}
		const xml = buildSitemapXml(
			'https://albait.example',
			data.sitemap,
			data.locales,
		)
		expect(xml).toContain('<loc>https://albait.example/locations/olaya</loc>')
		expect(xml).toContain(
			'<loc>https://albait.example/ar/locations/olaya</loc>',
		)
		expect(xml).toContain(
			'hreflang="ar" href="https://albait.example/ar/events/trivia"',
		)
	})

	it('puts cuisine, price range, location pages and events in llms.txt', async () => {
		const data = await loadSiteSeoData(organization as never, {
			slug: 'albait',
			host: null,
		})
		const text = buildLlmsTxt({
			origin: 'https://albait.example',
			...data.llms,
		})
		expect(text).toContain('Cuisine: Lebanese, Shawarma')
		expect(text).toContain('Price range: ﷼﷼')
		expect(text).toContain('- Page: https://albait.example/locations/olaya')
		// The location's own cuisine and price differ from the organization's.
		expect(text).toContain('- Cuisine: Sushi')
		expect(text).toContain('- Price range: ﷼﷼﷼﷼')
		expect(text).toContain('## Upcoming events')
		expect(text).toContain(
			'[trivia](https://albait.example/events/trivia): 2026-12-01T20:00:00+03:00',
		)
		expect(text).not.toContain('old-brunch')
	})

	it('leaves everything out while the features are off', async () => {
		org.fetchPublishedLanding.mockResolvedValue(null)
		org.fetchPublishedEvents.mockResolvedValue(null)
		const data = await loadSiteSeoData(
			{ ...organization, cuisines: [], priceRange: null } as never,
			{ slug: 'albait', host: null },
		)
		const paths = data.sitemap.map((entry) => entry.path)
		expect(
			paths.some((path) => /^\/(locations|events|delivery)/.test(path)),
		).toBe(false)
		const text = buildLlmsTxt({
			origin: 'https://albait.example',
			...data.llms,
		})
		expect(text).not.toContain('Cuisine:')
		expect(text).not.toContain('Price range:')
	})
})

describe('loadSiteSeoData: ordering goes to another site (#318)', () => {
	const elsewhere = {
		...organization,
		actionTargets: {
			organization: {
				order: { mode: 'external', url: 'https://order.toast.example/albait' },
			},
			locations: {},
		},
	}

	it('leaves the menu, dish and delivery pages out of the sitemap and llms.txt', async () => {
		const data = await loadSiteSeoData(elsewhere as never, {
			slug: 'albait',
			host: null,
		})
		const paths = data.sitemap.map((entry) => entry.path)
		for (const path of ['/menu', '/menu/falafel', '/delivery/al-malqa']) {
			expect(paths).not.toContain(path)
		}
		expect(data.llms.links.map((link) => link.path)).not.toContain('/menu')
		// Other pages stay.
		expect(paths).toEqual(
			expect.arrayContaining(['/locations/olaya', '/events/trivia']),
		)
	})

	it('lists them again as soon as ordering is on Menuza', async () => {
		const back = {
			...organization,
			actionTargets: {
				organization: { order: { mode: 'menuza' } },
				locations: {},
			},
		}
		const data = await loadSiteSeoData(back as never, {
			slug: 'albait',
			host: null,
		})
		const paths = data.sitemap.map((entry) => entry.path)
		expect(paths).toEqual(
			expect.arrayContaining(['/menu', '/menu/falafel', '/delivery/al-malqa']),
		)
	})

	it('keeps them while one location still orders through Menuza', async () => {
		const mixed = {
			...elsewhere,
			actionTargets: {
				...elsewhere.actionTargets,
				locations: { l2: { order: { mode: 'menuza' } } },
			},
		}
		const data = await loadSiteSeoData(mixed as never, {
			slug: 'albait',
			host: null,
		})
		expect(data.sitemap.map((entry) => entry.path)).toContain('/menu')
	})
})
