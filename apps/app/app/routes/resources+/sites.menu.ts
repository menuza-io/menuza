import {
	DEFAULT_DELIVERY_CONFIG,
	DEFAULT_FULFILLMENT_OPTIONS,
	DEFAULT_IN_HOUSE_TIPS,
	DEFAULT_SCHEDULING,
	DEFAULT_WEEKLY_SCHEDULE,
	getLocationCurrency,
	type DeliveryConfig,
	type DeliveryZone,
	type FulfillmentOptions,
	type InHouseTips,
	type LocationAddress,
	type SchedulingOptions,
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import {
	and,
	asc,
	desc,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	buildPublicMenusForOrganization,
	loadLocationOverrides,
	type PublicLocationOverridesMap,
	type PublicMenuData,
} from '#app/utils/menu/public-projection.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	getCachedSiteData,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'

export interface PublicLocationData {
	id: string
	name: string
	slug: string
	phone: string | null
	timezone: string
	taxRate: number
	address: LocationAddress | null
	currency: 'USD' | 'CAD'
	storeHours: WeeklySchedule
	onlineHours: WeeklySchedule
	specialHours: SpecialHour[]
	prepTime: number
	fulfillmentOptions: FulfillmentOptions
	inHouseTips: InHouseTips
	scheduling: SchedulingOptions
	deliveryConfig: DeliveryConfig
	deliveryZones: DeliveryZone[]
	isDefault: boolean
}

export interface PublicSiteMenuPayload {
	organization: {
		id: string
		name: string
		slug: string
		currency: string
		defaultLocale: string
		locales: string[]
	}
	locations: PublicLocationData[]
	menus: PublicMenuData[]
	locationOverrides: PublicLocationOverridesMap
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}

/**
 * Public endpoint for fetching an organization's restaurant menus, active locations,
 * categories, items, modifiers, and options with edge KV caching.
 *
 * Menus are served from their published snapshot (the master-menu publish
 * gate) when one exists; menus that have never been published fall back to
 * live content. Location overrides are operational data and stay live.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const slug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const host =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const locationId = url.searchParams.get('locationId') || null
	// Accept both `preview=1` (sent by apps/sites) and `preview=true`.
	const previewParam = url.searchParams.get('preview')
	const wantsPreview = previewParam === '1' || previewParam === 'true'

	if (!slug && !host) {
		throw new Response('Not Found', { status: 404 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		PUBLIC_SITE_RATE_LIMIT,
	)

	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	// 1. Resolve organization
	type OrgSelect = {
		id: string
		name: string
		slug: string
		siteDefaultLocale: string | null
		siteLocales: string | null
		customDomain: string | null
		currency: string
	}
	let org: OrgSelect | undefined
	if (slug) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.slug, slug),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
				),
			)
			.limit(1)
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	} else if (host) {
		const [found] = await db
			.select({
				id: Organization.id,
				name: Organization.name,
				slug: Organization.slug,
				siteDefaultLocale: Organization.siteDefaultLocale,
				siteLocales: Organization.siteLocales,
				customDomain: Organization.customDomain,
				dataRegion: Organization.dataRegion,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.customDomain, host),
					eq(Organization.active, true),
					eq(Organization.sitePublished, true),
					inArray(Organization.customDomainStatus, ['active', 'pending']),
				),
			)
			.limit(1)
		if (found) {
			org = {
				id: found.id,
				name: found.name,
				slug: found.slug,
				siteDefaultLocale: found.siteDefaultLocale,
				siteLocales: found.siteLocales,
				customDomain: found.customDomain,
				currency: found.dataRegion === 'ksa' ? 'SAR' : 'USD',
			}
		}
	}

	if (!org) {
		throw new Response('Not Found', { status: 404 })
	}

	// `preview` bypasses the edge KV cache, which forces an uncached full menu
	// scan. Only honour it when the request presents the organization's own
	// custom domain via the `host` signal this route already trusts to resolve a
	// custom-domain org, so an anonymous `?preview=1` cannot trigger it.
	const isPreview =
		wantsPreview && Boolean(host) && org.customDomain?.toLowerCase() === host

	const orgId = org.id
	const queryHash = locationId || 'all'
	const cacheKey = getSiteKvKey('page', orgId, `menu-${queryHash}`)

	// Check KV Cache
	if (!isPreview) {
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Accept-Language',
				},
			})
		}
	}

	// 2. Fetch Locations
	const rawLocations = await db
		.select()
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, orgId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)

	const locations: PublicLocationData[] = rawLocations.map((loc) => {
		const parsedAddress = safeJsonParse<LocationAddress | null>(
			loc.address,
			null,
		)
		return {
			id: loc.id,
			name: loc.name,
			slug: loc.slug,
			phone: loc.phone,
			timezone: loc.timezone || 'UTC',
			taxRate: loc.taxRate || 0,
			address: parsedAddress,
			currency: getLocationCurrency(parsedAddress),
			storeHours: safeJsonParse<WeeklySchedule>(
				loc.storeHours,
				DEFAULT_WEEKLY_SCHEDULE,
			),
			onlineHours: safeJsonParse<WeeklySchedule>(
				loc.onlineHours,
				DEFAULT_WEEKLY_SCHEDULE,
			),
			specialHours: safeJsonParse<SpecialHour[]>(loc.specialHours, []),
			prepTime: loc.prepTime || 15,
			fulfillmentOptions: safeJsonParse<FulfillmentOptions>(
				loc.fulfillmentOptions,
				DEFAULT_FULFILLMENT_OPTIONS,
			),
			inHouseTips: safeJsonParse<InHouseTips>(
				loc.inHouseTips,
				DEFAULT_IN_HOUSE_TIPS,
			),
			scheduling: safeJsonParse<SchedulingOptions>(
				loc.scheduling,
				DEFAULT_SCHEDULING,
			),
			deliveryConfig: safeJsonParse<DeliveryConfig>(
				loc.deliveryConfig,
				DEFAULT_DELIVERY_CONFIG,
			),
			deliveryZones: safeJsonParse<DeliveryZone[]>(loc.deliveryZones, []),
			isDefault: Boolean(loc.isDefault),
		}
	})

	// 3. Build menus (published snapshot when available, live otherwise) and
	// location overrides.
	const [{ menus, nextVariationExpiry }, locationOverridesMap] =
		await Promise.all([
			buildPublicMenusForOrganization(orgId),
			loadLocationOverrides(orgId),
		])

	const activeLocation =
		(locationId ? locations.find((l) => l.id === locationId) : undefined) ||
		locations.find((l) => l.isDefault) ||
		locations[0]

	const payload: PublicSiteMenuPayload = {
		organization: {
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency: activeLocation?.currency || org.currency || 'USD',
			defaultLocale: org.siteDefaultLocale || 'en',
			locales: safeJsonParse<string[]>(org.siteLocales, ['en']),
		},
		locations,
		menus,
		locationOverrides: locationOverridesMap,
	}

	const now = Date.now()
	const secondsUntilVariationReturn =
		nextVariationExpiry === null
			? null
			: Math.ceil((nextVariationExpiry - now) / 1000)
	if (
		!isPreview &&
		(secondsUntilVariationReturn === null || secondsUntilVariationReturn >= 60)
	) {
		await setCachedSiteData(
			cacheKey,
			payload,
			secondsUntilVariationReturn ?? undefined,
		)
	}

	const cacheControl =
		secondsUntilVariationReturn !== null && secondsUntilVariationReturn < 60
			? `public, max-age=${Math.max(1, secondsUntilVariationReturn)}`
			: 'public, max-age=60, stale-while-revalidate=300'

	return Response.json(payload, {
		headers: {
			'Cache-Control': cacheControl,
			Vary: 'Accept-Language',
		},
	})
}
