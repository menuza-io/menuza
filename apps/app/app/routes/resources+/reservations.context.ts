import { resolveEmailTheme } from '@repo/common/email-theme'
import { getLocationCurrency } from '@repo/common/location-currency'
import {
	and,
	asc,
	db,
	desc,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { reservationsContextSchema } from '@repo/reservations'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { displayLocationName } from '#app/utils/location-name.server.ts'
import {
	getReservationsFeatureState,
	getReservationsPlatformFeeBp,
} from '#app/utils/reservations/access.server.ts'
import { resolveSitesOrigin } from '#app/utils/reservations/sites-origin.server.ts'
import { resolveRestaurantOnlinePayment } from '#app/utils/restaurant-orders/payment-config.server.ts'
import { getStaffingFeatureState } from '#app/utils/staffing/access.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

function parseJsonSafe(raw: string | null): unknown {
	if (!raw) return null
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

function parseLocationAddress(raw: string | null): {
	formattedAddress: string | null
	city: string | null
	lat: number | null
	lng: number | null
} | null {
	if (!raw) return null
	const parsed = parseJsonSafe(raw)
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		const obj = parsed as Record<string, unknown>
		return {
			formattedAddress:
				typeof obj.formattedAddress === 'string'
					? obj.formattedAddress
					: typeof obj.address === 'string'
						? obj.address
						: null,
			city: typeof obj.city === 'string' ? obj.city : null,
			lat: typeof obj.lat === 'number' ? obj.lat : null,
			lng: typeof obj.lng === 'number' ? obj.lng : null,
		}
	}
	return {
		formattedAddress: raw,
		city: null,
		lat: null,
		lng: null,
	}
}

function parseLocales(raw: string | null, defaultLocale: string): string[] {
	const parsed = parseJsonSafe(raw)
	if (Array.isArray(parsed)) {
		const valid = parsed.filter(
			(item): item is string =>
				typeof item === 'string' && item.trim().length > 0,
		)
		if (valid.length > 0) return valid
	}
	return [defaultLocale]
}

/**
 * Internal machine-to-machine reservations context endpoint:
 * `GET /resources/reservations/context?orgId=<id>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN` (`requireInternalCommandAuth`).
 * Returns non-PII organization metadata, folded `reservations.*` flags, hex-converted
 * email branding, locations, payment processor readiness, and staffing/voice flags.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return Response.json({ error: 'Forbidden' }, { status: 403 })
		}
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const { orgId } = parsed.data

	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			active: Organization.active,
			dataRegion: Organization.dataRegion,
			customDomain: Organization.customDomain,
			sitePublished: Organization.sitePublished,
			siteDefaultLocale: Organization.siteDefaultLocale,
			siteLocales: Organization.siteLocales,
			siteIconKey: Organization.siteIconKey,
			siteTheme: Organization.siteTheme,
			staffingTimeZone: Organization.staffingTimeZone,
			shopPaymentProvider: Organization.shopPaymentProvider,
			stripeConnectAccountId: Organization.stripeConnectAccountId,
			stripeConnectChargesEnabled: Organization.stripeConnectChargesEnabled,
			checkoutSubEntityId: Organization.checkoutSubEntityId,
			checkoutChargesEnabled: Organization.checkoutChargesEnabled,
		})
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const dataRegion: 'us' | 'ksa' =
		(org.dataRegion || 'us').toLowerCase() === 'ksa' ? 'ksa' : 'us'

	const [features, platformFeeBp, staffingFeatures, locationRows] =
		await Promise.all([
			getReservationsFeatureState(org.id),
			getReservationsPlatformFeeBp(),
			getStaffingFeatureState(org.id),
			db
				.select({
					id: OrganizationLocation.id,
					slug: OrganizationLocation.slug,
					name: OrganizationLocation.name,
					timezone: OrganizationLocation.timezone,
					address: OrganizationLocation.address,
					phone: OrganizationLocation.phone,
					storeHours: OrganizationLocation.storeHours,
					specialHours: OrganizationLocation.specialHours,
					isDefault: OrganizationLocation.isDefault,
					isActive: OrganizationLocation.isActive,
				})
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, org.id))
				.orderBy(
					desc(OrganizationLocation.isDefault),
					asc(OrganizationLocation.createdAt),
				),
		])

	const onlinePayment = resolveRestaurantOnlinePayment(org)
	const currency: 'USD' | 'CAD' | 'SAR' = dataRegion === 'ksa' ? 'SAR' : 'USD'
	const defaultTimeZone =
		org.staffingTimeZone ||
		(dataRegion === 'ksa' ? 'Asia/Riyadh' : 'America/New_York')

	const appUrl = (ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '')
	const resolvedTheme = resolveEmailTheme({
		organizationName: org.name,
		logoUrl: org.siteIconKey
			? `/resources/images?objectKey=${encodeURIComponent(org.siteIconKey)}`
			: null,
		appUrl,
		siteTheme: org.siteTheme,
	})
	const defaultLocale = org.siteDefaultLocale || 'en'
	const locales = parseLocales(org.siteLocales, defaultLocale)
	const siteOrigin = resolveSitesOrigin({
		slug: org.slug,
		customDomain: org.customDomain,
		baseUrl: appUrl,
		hostSuffixes: ENV.PUBLIC_SITE_HOST_SUFFIXES,
	})
	const paymentActive = Boolean(features.payments && onlinePayment.enabled)

	const payload = reservationsContextSchema.parse({
		orgId: org.id,
		dataRegion,
		features,
		organization: {
			name: org.name,
			slug: org.slug,
			defaultLocale,
			locales,
			siteOrigin,
			sitePublished: Boolean(org.sitePublished),
			emailTheme: resolvedTheme,
			logoUrl: resolvedTheme.logoUrl,
		},
		locations: locationRows.map((loc) => ({
			id: loc.id,
			name: displayLocationName(loc.name, defaultLocale, defaultLocale),
			slug: loc.slug,
			timeZone: loc.timezone || defaultTimeZone,
			currency: loc.address ? getLocationCurrency(loc.address) : currency,
			phone: loc.phone ?? null,
			address: parseLocationAddress(loc.address),
			storeHours: parseJsonSafe(loc.storeHours),
			specialHours: parseJsonSafe(loc.specialHours),
			isActive: Boolean(loc.isActive),
		})),
		payments: {
			processor: paymentActive ? onlinePayment.processor : null,
			deposit: paymentActive,
			guarantee: paymentActive,
			platformFeeBp,
		},
		staffing: {
			enabled: staffingFeatures.enabled,
		},
		voice: {
			enabled: features.voice,
		},
	})

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'private, no-store',
		},
	})
}
