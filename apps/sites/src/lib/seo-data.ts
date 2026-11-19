import { cuisineLabel, formatPriceRange } from '@repo/common/cuisines'
import { visibleDishPages } from '~/lib/landing-pages'
import {
	type PublicOrganization,
	fetchPublishedCareers,
	fetchPublishedDrops,
	fetchPublishedEvents,
	fetchPublishedLanding,
	fetchPublishedReservations,
	fetchPublishedSiteMenu,
	fetchPublishedSitePages,
} from '~/lib/org'
import {
	type LlmsInput,
	type SeoLocales,
	type SitemapEntry,
	localizedName,
	pagePath,
} from '~/lib/seo-files'

/** Item statuses that should not be advertised. */
const UNLISTED_STATUSES = new Set(['hidden', 'unavailable'])

export type SiteSeoData = {
	locales: SeoLocales
	sitemap: SitemapEntry[]
	llms: Omit<LlmsInput, 'origin'>
}

/**
 * Everything public that `sitemap.xml` and `llms.txt` list for one site. Each
 * source is optional: a module that is off (or a call that fails) just leaves
 * its pages out.
 */
export async function loadSiteSeoData(
	organization: PublicOrganization,
	where: { slug: string | null; host: string | null },
): Promise<SiteSeoData> {
	const locales: SeoLocales = {
		locales: organization.locales?.length ? organization.locales : ['en'],
		defaultLocale: organization.defaultLocale ?? 'en',
	}

	const [pages, menu, reservations, careers, drops, landing, events] =
		await Promise.all([
			fetchPublishedSitePages(where),
			fetchPublishedSiteMenu({ ...where, lng: locales.defaultLocale }),
			fetchPublishedReservations(where),
			fetchPublishedCareers({ ...where, locale: locales.defaultLocale }),
			fetchPublishedDrops(where),
			fetchPublishedLanding(where),
			fetchPublishedEvents({ ...where, lng: locales.defaultLocale }),
		])

	const sitemap: SitemapEntry[] = []
	const links: LlmsInput['links'] = []
	let description: string | null = null

	for (const page of pages) {
		const path = pagePath(page.slug, page.isHomePage)
		sitemap.push({ path, lastModified: page.updatedAt })
		if (path === '/') {
			description ??= page.description
			continue
		}
		links.push({ title: page.title, path, description: page.description })
	}
	if (!sitemap.some((entry) => entry.path === '/')) {
		sitemap.unshift({ path: '/' })
	}

	const menus = menu?.menus ?? []
	const categories: LlmsInput['menu'] = []
	for (const published of menus) {
		for (const category of published.categories ?? []) {
			const items = (category.items ?? [])
				.filter((item) => !UNLISTED_STATUSES.has(item.availabilityStatus))
				.map((item) => ({
					name: localizedName(item.displayName, locales),
					price: Number.isFinite(item.price) ? item.price : null,
				}))
				.filter((item) => item.name)
			const name = localizedName(category.displayName, locales)
			if (name && items.length) categories.push({ name, items })
		}
	}
	if (menus.length) {
		sitemap.push({ path: '/menu' })
		links.unshift({ title: 'Menu and online ordering', path: '/menu' })
	}

	if (reservations?.online) {
		sitemap.push({ path: '/reserve' })
		links.push({ title: 'Reserve a table', path: '/reserve' })
	}

	const postings = careers?.postings ?? []
	if (postings.length) {
		sitemap.push({ path: '/careers' })
		links.push({ title: 'Careers', path: '/careers' })
		for (const posting of postings) {
			sitemap.push({ path: `/careers/${encodeURIComponent(posting.slug)}` })
		}
	}

	const openDrops = drops.filter(
		(drop) => drop.status === 'live' || drop.status === 'scheduled',
	)
	if (openDrops.length) {
		sitemap.push({ path: '/drops' })
		for (const drop of openDrops) {
			sitemap.push({ path: `/drop/${encodeURIComponent(drop.slug)}` })
		}
	}

	// Generated pages (#137). Operator pages with the same path came first and
	// the sitemap keeps the first entry for a path.
	const locationPages = landing?.features.locationPages ? landing.locations : []
	const locationPath = (slug: string) =>
		`/locations/${encodeURIComponent(slug)}`
	if (locationPages.length > 1) {
		sitemap.push({ path: '/locations' })
		links.push({ title: 'Locations', path: '/locations' })
	}
	for (const location of locationPages) {
		sitemap.push({
			path: locationPath(location.slug),
			lastModified: location.updatedAt,
		})
	}
	for (const dish of visibleDishPages(landing, menu)) {
		sitemap.push({ path: `/menu/${encodeURIComponent(dish.slug)}` })
	}
	for (const area of landing?.features.areaPages ? landing.areas : []) {
		// Thin pages without an operator introduction stay out until written.
		if (!area.noIndex)
			sitemap.push({ path: `/delivery/${encodeURIComponent(area.slug)}` })
	}

	// Events (#184): only upcoming ones; a finished event leaves the sitemap.
	const upcoming = (events?.events ?? []).filter(
		(event) => event.phase === 'upcoming' && event.occurrences.length,
	)
	if (upcoming.length) {
		sitemap.push({ path: '/events' })
		links.push({ title: 'Events', path: '/events' })
		for (const event of upcoming) {
			sitemap.push({
				path: `/events/${encodeURIComponent(event.slug)}`,
				lastModified: event.updatedAt,
			})
		}
	}

	const currency = menu?.organization?.currency ?? null
	const englishCuisines = (keys: readonly string[] | undefined) =>
		(keys ?? []).map((key) => cuisineLabel(key, 'en')).filter(Boolean)
	const orgCuisines = englishCuisines(organization.cuisines)
	const byLocationId = new Map(
		locationPages.map((location) => [location.id, location]),
	)

	return {
		locales,
		sitemap,
		llms: {
			name: menu?.organization?.name || organization.name,
			description,
			currency: menu?.organization?.currency ?? null,
			locales,
			cuisines: orgCuisines,
			priceRange: organization.priceRange ?? null,
			locations: (menu?.locations ?? []).map((location) => {
				const page = byLocationId.get(location.id)
				const cuisines = englishCuisines(page?.cuisines)
				const ownPrice = page ? formatPriceRange(page.priceRange, currency) : ''
				return {
					name: localizedName(location.name, locales),
					phone: location.phone,
					address: location.address,
					storeHours: location.storeHours,
					path: page ? locationPath(page.slug) : null,
					// Only when it differs from the organization's.
					cuisines:
						cuisines.join() !== orgCuisines.join() ? cuisines : undefined,
					priceRange:
						ownPrice && ownPrice !== organization.priceRange ? ownPrice : null,
				}
			}),
			menu: categories,
			links,
			events: upcoming.map((event) => ({
				title: event.title,
				path: `/events/${encodeURIComponent(event.slug)}`,
				start: event.occurrences[0]!.start,
			})),
		},
	}
}
