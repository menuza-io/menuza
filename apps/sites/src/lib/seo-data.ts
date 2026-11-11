import {
	type PublicOrganization,
	fetchPublishedCareers,
	fetchPublishedDrops,
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

	const [pages, menu, reservations, careers, drops] = await Promise.all([
		fetchPublishedSitePages(where),
		fetchPublishedSiteMenu({ ...where, lng: locales.defaultLocale }),
		fetchPublishedReservations(where),
		fetchPublishedCareers({ ...where, locale: locales.defaultLocale }),
		fetchPublishedDrops(where),
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

	return {
		locales,
		sitemap,
		llms: {
			name: menu?.organization?.name || organization.name,
			description,
			currency: menu?.organization?.currency ?? null,
			locales,
			locations: (menu?.locations ?? []).map((location) => ({
				name: localizedName(location.name, locales),
				phone: location.phone,
				address: location.address,
				storeHours: location.storeHours,
			})),
			menu: categories,
			links,
		},
	}
}
