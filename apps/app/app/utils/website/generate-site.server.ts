/**
 * Saves an AI site as drafts (#141). The published home page is never
 * overwritten. A generation is one preview; more than five in a day are
 * refused.
 */
import { locationOffersOrdering } from '@repo/common/restaurant-sections'
import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	gt,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
	WebsitePage,
	WebsitePageSection,
	WebsiteSiteGeneration,
} from '@repo/database'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import {
	assembleGeneratedSite,
	fixtureSiteCopy,
	generationAllowed,
	SITE_GENERATIONS_PER_DAY,
	type GeneratedSite,
	type SiteFacts,
	type SiteTone,
} from './generate-site.ts'

export async function loadSiteFacts(
	organizationId: string,
	tone: SiteTone,
	logoSamples: SiteFacts['logoSamples'],
): Promise<SiteFacts> {
	const [org] = await db
		.select({
			name: Organization.name,
			description: Organization.description,
			cuisines: Organization.cuisines,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) throw new Error('Organization not found')
	const localeConfig = parseSiteLocalesConfig(
		org.siteLocales,
		org.siteDefaultLocale,
	)
	const defaultLocale = localeConfig.defaultLocale
	const reservationsState = await getReservationsFeatureState(organizationId)
	const [locations, dishes] = await Promise.all([
		db
			.select({
				name: OrganizationLocation.name,
				address: OrganizationLocation.address,
				phone: OrganizationLocation.phone,
				storeHours: OrganizationLocation.storeHours,
				fulfillmentOptions: OrganizationLocation.fulfillmentOptions,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId))
			.limit(20),
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				description: OrganizationMenuItem.description,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.limit(40),
	])
	let cuisines: string[] = []
	try {
		const parsed = JSON.parse(org.cuisines ?? '[]') as unknown
		if (Array.isArray(parsed)) {
			cuisines = parsed.filter(
				(item): item is string => typeof item === 'string',
			)
		}
	} catch {
		cuisines = []
	}
	return {
		organizationName: org.name,
		description: org.description,
		cuisines,
		locales: localeConfig.locales,
		defaultLocale,
		tone,
		ordering: locations.some((location) =>
			locationOffersOrdering(location.fulfillmentOptions),
		),
		reservations: reservationsState.enabled && reservationsState.online,
		locations: locations.map((location) => ({
			name: pickLocalized(location.name, defaultLocale, defaultLocale),
			address: location.address ?? '',
			phone: location.phone,
			hours: location.storeHours ?? '',
		})),
		dishes: dishes.map((dish) => ({
			id: dish.id,
			name: pickLocalized(dish.displayName, defaultLocale, defaultLocale),
			description: pickLocalized(
				dish.description,
				defaultLocale,
				defaultLocale,
			),
		})),
		photos: [],
		logoSamples,
	}
}

export async function generationsInLastDay(organizationId: string) {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const rows = await db
		.select({ id: WebsiteSiteGeneration.id })
		.from(WebsiteSiteGeneration)
		.where(
			and(
				eq(WebsiteSiteGeneration.organizationId, organizationId),
				gt(WebsiteSiteGeneration.createdAt, since),
			),
		)
	return rows.length
}

export async function recordGeneration(organizationId: string) {
	await db.insert(WebsiteSiteGeneration).values({ organizationId })
}

export function buildGeneratedSite(facts: SiteFacts) {
	return assembleGeneratedSite(facts, fixtureSiteCopy(facts))
}

export async function saveGeneratedDrafts(
	organizationId: string,
	userId: string,
	site: GeneratedSite,
) {
	const existing = await db
		.select({
			slug: WebsitePage.slug,
			isHomePage: WebsitePage.isHomePage,
			status: WebsitePage.status,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organizationId))
	const used = new Set(existing.map((page) => page.slug))
	const created: string[] = []
	for (const page of site.pages) {
		let slug = page.slug
		if (used.has(slug)) {
			slug = `${page.slug}-ai-draft`
			let n = 2
			while (used.has(slug)) {
				slug = `${page.slug}-ai-draft-${n}`
				n += 1
			}
		}
		used.add(slug)
		const [row] = await db
			.insert(WebsitePage)
			.values({
				organizationId,
				title: page.role === 'home' ? 'Home (AI draft)' : page.title,
				slug,
				status: 'draft',
				template: 'restaurant',
				isHomePage: false,
				createdById: userId,
				generatedBy: 'ai',
			})
			.returning({ id: WebsitePage.id })
		if (!row) continue
		if (page.sections.length > 0) {
			await db.insert(WebsitePageSection).values(
				page.sections.map((section, index) => ({
					pageId: row.id,
					type: section.type,
					position: index,
					config: JSON.stringify(section.config),
				})),
			)
		}
		created.push(row.id)
	}
	return created
}

export { generationAllowed, SITE_GENERATIONS_PER_DAY }
