/**
 * Generated website pages (#137): location pages (`/locations/<slug>`), dish
 * pages (`/menu/<slug>`) and delivery area pages (`/delivery/<slug>`). Public
 * business data only: names, addresses, hours, prices, operator copy.
 */
import {
	parseStoredCuisines,
	resolveCuisineAndPrice,
	type CuisineKey,
	type PriceRangeLevel,
} from '@repo/common/cuisines'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { buildAreaPages, type AreaPage } from '@repo/common/site-landing-pages'
import {
	and,
	asc,
	db,
	desc,
	eq,
	OrganizationLocation,
	OrganizationMenuItem,
	SiteAreaPage,
} from '@repo/database'
import {
	automaticRedirectStatements,
	loadRedirectRows,
	planAutomaticRedirect,
} from '#app/utils/website/redirects.server.ts'

export const LANDING_FLAGS = {
	locationPages: 'website.location_pages',
	dishPages: 'website.dish_pages',
	areaPages: 'website.area_pages',
	events: 'website.events',
} as const

export type LandingFeatures = {
	locationPages: boolean
	dishPages: boolean
	areaPages: boolean
	events: boolean
}

/** Only a literal `true` counts. Location pages are on unless turned off. */
export async function getLandingFeatures(
	organizationId: string,
): Promise<LandingFeatures> {
	const [locationPages, dishPages, areaPages, events] = await Promise.all(
		Object.values(LANDING_FLAGS).map((key) =>
			getFeatureFlag(key, { organizationId }),
		),
	)
	return {
		// Default on once built (#137): only an explicit `false` turns them off.
		locationPages: locationPages !== false,
		dishPages: dishPages === true,
		areaPages: areaPages === true,
		events: events === true,
	}
}

export type PublicLandingLocation = {
	id: string
	slug: string
	name: string
	phone: string | null
	address: unknown
	storeHours: unknown
	specialHours: unknown
	timezone: string
	fulfillmentOptions: unknown
	isDefault: boolean
	/** Localized JSON text, or null. */
	intro: string | null
	seoTitle: string | null
	seoDescription: string | null
	cuisines: CuisineKey[]
	priceRange: PriceRangeLevel | null
	updatedAt: string
}

export type PublicLandingPayload = {
	features: LandingFeatures
	locations: PublicLandingLocation[]
	/** Locations that had a page and no longer do (deactivated or switched off): 410. */
	goneLocationSlugs: string[]
	/** Dishes with "Give this dish its own page"; Sites checks they are visible. */
	dishes: Array<{ id: string; slug: string }>
	areas: Array<AreaPage & { locationSlug: string }>
}

function parseJson(value: string | null): unknown {
	if (!value) return null
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

/** Everything Sites needs for the generated pages, sitemap and llms.txt. */
export async function buildPublicLandingPayload(organization: {
	id: string
	cuisines: string | null
	priceRange: number | null
}): Promise<PublicLandingPayload> {
	const features = await getLandingFeatures(organization.id)
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			slug: OrganizationLocation.slug,
			name: OrganizationLocation.name,
			phone: OrganizationLocation.phone,
			address: OrganizationLocation.address,
			storeHours: OrganizationLocation.storeHours,
			specialHours: OrganizationLocation.specialHours,
			timezone: OrganizationLocation.timezone,
			fulfillmentOptions: OrganizationLocation.fulfillmentOptions,
			deliveryZones: OrganizationLocation.deliveryZones,
			isActive: OrganizationLocation.isActive,
			isDefault: OrganizationLocation.isDefault,
			sitePageEnabled: OrganizationLocation.sitePageEnabled,
			siteIntro: OrganizationLocation.siteIntro,
			siteSeoTitle: OrganizationLocation.siteSeoTitle,
			siteSeoDescription: OrganizationLocation.siteSeoDescription,
			cuisines: OrganizationLocation.cuisines,
			priceRange: OrganizationLocation.priceRange,
			updatedAt: OrganizationLocation.updatedAt,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)

	const locations: PublicLandingLocation[] = []
	const goneLocationSlugs: string[] = []
	for (const row of rows) {
		if (!features.locationPages) break
		if (!row.isActive || !row.sitePageEnabled) {
			goneLocationSlugs.push(row.slug)
			continue
		}
		const resolved = resolveCuisineAndPrice(organization, row)
		locations.push({
			id: row.id,
			slug: row.slug,
			name: row.name,
			phone: row.phone,
			address: parseJson(row.address),
			storeHours: parseJson(row.storeHours),
			specialHours: parseJson(row.specialHours),
			timezone: row.timezone || 'UTC',
			fulfillmentOptions: parseJson(row.fulfillmentOptions),
			isDefault: row.isDefault,
			intro: row.siteIntro,
			seoTitle: row.siteSeoTitle,
			seoDescription: row.siteSeoDescription,
			cuisines: resolved.cuisines,
			priceRange: resolved.priceRange,
			updatedAt: row.updatedAt.toISOString(),
		})
	}

	const dishes = features.dishPages
		? (
				await db
					.select({
						id: OrganizationMenuItem.id,
						slug: OrganizationMenuItem.siteSlug,
					})
					.from(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.organizationId, organization.id),
							eq(OrganizationMenuItem.sitePageEnabled, true),
						),
					)
			).flatMap((row) => (row.slug ? [{ id: row.id, slug: row.slug }] : []))
		: []

	let areas: PublicLandingPayload['areas'] = []
	if (features.areaPages) {
		const areaRows = await db
			.select({
				organizationLocationId: SiteAreaPage.organizationLocationId,
				zoneId: SiteAreaPage.zoneId,
				slug: SiteAreaPage.slug,
				intro: SiteAreaPage.intro,
				enabled: SiteAreaPage.enabled,
			})
			.from(SiteAreaPage)
			.where(eq(SiteAreaPage.organizationId, organization.id))
		const slugById = new Map(rows.map((row) => [row.id, row.slug]))
		areas = buildAreaPages(rows, areaRows).map((page) => ({
			...page,
			locationSlug: slugById.get(page.locationId) ?? '',
		}))
	}

	return { features, locations, goneLocationSlugs, dishes, areas }
}

/** The organization-wide cuisines, for forms. */
export function organizationCuisineKeys(value: unknown): CuisineKey[] {
	return parseStoredCuisines(value) ?? []
}

/**
 * A location's address changed: `/locations/<old>` gets a 301 to the new
 * page, with the same chain and conflict rules as a renamed page (#88).
 */
export async function addLocationPageRedirect(
	organizationId: string,
	oldSlug: string,
	newSlug: string,
) {
	const plan = planAutomaticRedirect({
		existing: await loadRedirectRows(organizationId),
		oldPath: `/locations/${oldSlug}`,
		newPath: `/locations/${newSlug}`,
		source: 'location_rename',
	})
	const { statements } = automaticRedirectStatements(organizationId, null, plan)
	const [first, ...rest] = statements
	if (first) await db.batch([first, ...rest])
}
