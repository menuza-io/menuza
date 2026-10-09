import { Hono, type Context } from 'hono'
import { LRUCache } from 'lru-cache'

import {
	locationCountryCode,
	resolveDeliveryZoneForPoint,
	type PublicLocationContext,
} from '@repo/common/restaurant-orders'
import { GeocoderError, hasRealCoordinates, type GeoAddress } from '@repo/geo'
import { z } from 'zod'

import {
	DELIVERY_QUOTE_TTL_MS,
	signDeliveryQuote,
} from '../lib/delivery-quote-token.ts'
import { getGeocoder } from '../lib/geocoder.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { getNodeRegion } from '../lib/region.ts'
import { fetchOrderContext } from '../services/order-service.ts'
import { resolveOrderingOrganization } from './orders.ts'

/**
 * Delivery address search + coverage quotes.
 *
 * Data residency: the browser sends the customer's address straight to this
 * regional node, which calls the geocoder (Google Maps Platform) server-side.
 * Sites SSR never sees it, and nothing is stored: the result goes back to the
 * browser as a signed quote token that `POST /orders` re-verifies.
 */
export const publicDeliveryRoutes = new Hono()

const ETA_DEFAULT = { min: 25, max: 45 }
const LOCATION_CACHE_TTL_MS = 5 * 60 * 1000

function noStore() {
	return { 'Cache-Control': 'no-store' }
}

function languageFrom(value: string | undefined): string {
	const candidate = (value ?? '').trim()
	return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(candidate)
		? candidate
		: 'en'
}

function orgLimited(c: Context, name: string, orgId: string, max: number) {
	const limit = rateLimitByKey(name, orgId, {
		maxRequests: max,
		windowMs: 60 * 60 * 1000,
	})
	if (!limit.limited) return null
	return c.json(
		{
			error: 'rate_limit_exceeded',
			message: 'Too many address lookups. Please try again later.',
			retry_after: limit.retryAfter,
		},
		429,
		{ ...noStore(), 'Retry-After': String(limit.retryAfter) },
	)
}

type LocationGeoInfo = {
	deliveryEnabled: boolean
	bias: { lat: number; lng: number } | null
	country: string
}

/**
 * Autocomplete fires per keystroke, so the store bias/country is cached
 * briefly instead of fetching the full order context every time. Quotes
 * always use a fresh context.
 */
const locationGeoCache = new LRUCache<string, LocationGeoInfo>({
	max: 2000,
	ttl: LOCATION_CACHE_TTL_MS,
})

function geoInfoFor(location: PublicLocationContext): LocationGeoInfo {
	const address = location.address ?? null
	return {
		deliveryEnabled: Boolean(location.fulfillmentOptions.delivery),
		bias: hasRealCoordinates(address)
			? { lat: address.lat, lng: address.lng }
			: null,
		country: locationCountryCode(location),
	}
}

type LoadedLocation =
	| { ok: true; location: PublicLocationContext }
	| { ok: false; error: { status: number; code: string; message: string } }

async function loadLocation(
	orgId: string,
	locationId: string,
): Promise<LoadedLocation> {
	const context = await fetchOrderContext(orgId, locationId, null)
	if (!context.ok) return { ok: false, error: context.failure }
	if (getNodeRegion() !== context.data.dataRegion) {
		return {
			ok: false,
			error: {
				status: 503,
				code: 'ordering_unavailable',
				message:
					'Ordering is temporarily unavailable. Please try again shortly.',
			},
		}
	}
	const location = context.data.menu.locations.find(
		(candidate) => candidate.id === locationId,
	)
	if (!location) {
		return {
			ok: false,
			error: {
				status: 404,
				code: 'location_not_found',
				message: 'This location is not available for ordering.',
			},
		}
	}
	locationGeoCache.set(`${orgId}:${locationId}`, geoInfoFor(location))
	return { ok: true, location }
}

function failureResponse(
	c: Context,
	failure: { status: number; code: string; message: string },
) {
	return c.json(
		{ error: failure.code, message: failure.message },
		failure.status as 404 | 503,
		noStore(),
	)
}

// ---------------------------------------------------------------------------
// GET /delivery/places — address autocomplete (no PII stored or logged)
// ---------------------------------------------------------------------------

const placesQuerySchema = z.object({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
	locationId: z.string().trim().min(1).max(100),
	q: z.string().max(200).default(''),
	sessionToken: z.string().trim().min(1).max(100).optional(),
	/** Language (e.g. "en", "ar"). `locale` is accepted as an alias. */
	lng: z.string().max(20).optional(),
	locale: z.string().max(20).optional(),
})

publicDeliveryRoutes.get('/places', async (c) => {
	const parsed = placesQuerySchema.safeParse(c.req.query())
	if (!parsed.success) {
		return c.json(
			{ error: 'invalid_request', message: 'Invalid address search request' },
			400,
			noStore(),
		)
	}
	const query = parsed.data
	const organization = await resolveOrderingOrganization(c, {
		slug: query.slug,
		host: query.host,
	})
	if ('error' in organization) return organization.error
	const orgId = organization.organization.id

	const q = query.q.trim()
	if (q.length < 3) return c.json({ predictions: [] }, 200, noStore())

	const limited = orgLimited(c, 'delivery-places-org', orgId, 3000)
	if (limited) return limited

	let info = locationGeoCache.get(`${orgId}:${query.locationId}`)
	if (!info) {
		const loaded = await loadLocation(orgId, query.locationId)
		if (!loaded.ok) return failureResponse(c, loaded.error)
		info = geoInfoFor(loaded.location)
	}

	const geocoder = getGeocoder()
	if (!geocoder || !info.deliveryEnabled) {
		return c.json({ predictions: [] }, 200, noStore())
	}
	try {
		const predictions = await geocoder.autocomplete(q, {
			sessionToken: query.sessionToken,
			bias: info.bias,
			country: info.country,
			language: languageFrom(query.lng ?? query.locale),
		})
		return c.json({ predictions }, 200, noStore())
	} catch (error) {
		console.error(
			`Address autocomplete failed for org ${orgId} (${geocoder.name}):`,
			error instanceof GeocoderError ? error.message : 'unexpected error',
		)
		return c.json({ predictions: [] }, 200, noStore())
	}
})

// ---------------------------------------------------------------------------
// POST /delivery/quote — geocode + coverage + signed quote token
// ---------------------------------------------------------------------------

const quoteBodySchema = z
	.strictObject({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
		locationId: z.string().trim().min(1).max(100),
		placeId: z.string().trim().min(1).max(512).optional(),
		address: z.string().trim().min(3).max(300).optional(),
		unit: z.string().trim().max(50).optional(),
		sessionToken: z.string().trim().min(1).max(100).optional(),
		locale: z.string().max(20).optional(),
	})
	.refine((value) => Boolean(value.placeId || value.address), {
		message: 'Choose an address',
		path: ['address'],
	})

type QuoteAddress = {
	formatted: string
	line1: string
	unit?: string
	city: string
	state?: string
	postalCode?: string
	country?: string
	lat: number
	lng: number
}

function quoteAddress(place: GeoAddress, unit: string | null): QuoteAddress {
	return {
		formatted: place.formatted,
		line1: place.line1,
		...(unit ? { unit } : {}),
		city: place.city,
		...(place.state ? { state: place.state } : {}),
		...(place.postalCode ? { postalCode: place.postalCode } : {}),
		...(place.country ? { country: place.country } : {}),
		lat: place.lat,
		lng: place.lng,
	}
}

function unavailable(
	c: Context,
	reason:
		| 'delivery_disabled'
		| 'geocoding_unavailable'
		| 'store_location_missing'
		| 'no_zones',
) {
	return c.json({ status: 'unavailable', reason }, 200, noStore())
}

publicDeliveryRoutes.post('/quote', async (c) => {
	const rawBody = await c.req.json().catch(() => null)
	const parsed = quoteBodySchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid quote request',
			},
			400,
			noStore(),
		)
	}
	const body = parsed.data
	const organization = await resolveOrderingOrganization(c, {
		slug: body.slug,
		host: body.host,
	})
	if ('error' in organization) return organization.error
	const orgId = organization.organization.id

	const limited = orgLimited(c, 'delivery-quote-org', orgId, 600)
	if (limited) return limited

	const loaded = await loadLocation(orgId, body.locationId)
	if (!loaded.ok) return failureResponse(c, loaded.error)
	const { location } = loaded

	if (!location.fulfillmentOptions.delivery) {
		return unavailable(c, 'delivery_disabled')
	}
	const hasAllowedZone = (location.deliveryZones ?? []).some(
		(zone) =>
			zone.enabled &&
			zone.restriction === 'allowed' &&
			zone.provider === 'in_house',
	)
	if (!hasAllowedZone) return unavailable(c, 'no_zones')

	const geocoder = getGeocoder()
	if (!geocoder) return unavailable(c, 'geocoding_unavailable')

	const language = languageFrom(body.locale)
	const country = locationCountryCode(location)
	let place: GeoAddress | null
	try {
		place = body.placeId
			? await geocoder.placeDetails(body.placeId, {
					sessionToken: body.sessionToken,
					language,
				})
			: await geocoder.geocode(body.address!, { country, language })
	} catch (error) {
		console.error(
			`Delivery quote geocoding failed for org ${orgId} (${geocoder.name}):`,
			error instanceof GeocoderError ? error.message : 'unexpected error',
		)
		return unavailable(c, 'geocoding_unavailable')
	}
	if (!place || !hasRealCoordinates(place)) {
		return c.json({ status: 'not_found' }, 200, noStore())
	}

	const unit = body.unit || null
	const address = quoteAddress(place, unit)
	const coverage = resolveDeliveryZoneForPoint(location, {
		lat: place.lat,
		lng: place.lng,
		postalCode: place.postalCode || null,
	})
	if (!coverage.ok) {
		if (coverage.reason === 'out_of_range' || coverage.reason === 'excluded') {
			return c.json({ status: 'out_of_range', address }, 200, noStore())
		}
		return unavailable(c, coverage.reason)
	}

	const expiresAt = new Date(Date.now() + DELIVERY_QUOTE_TTL_MS)
	const token = await signDeliveryQuote({
		orgId,
		locationId: location.id,
		lat: place.lat,
		lng: place.lng,
		formatted: place.formatted.slice(0, 300),
		line1: place.line1.slice(0, 200),
		city: place.city.slice(0, 100),
		state: place.state ? place.state.slice(0, 100) : null,
		postalCode: place.postalCode ? place.postalCode.slice(0, 20) : null,
		country: /^[A-Z]{2}$/.test(place.country) ? place.country : null,
		unit,
		exp: expiresAt.getTime(),
	})
	const zone = coverage.zone
	const eta = location.deliveryConfig
		? {
				min:
					location.deliveryConfig.estimatedDeliveryTimeMin || ETA_DEFAULT.min,
				max:
					location.deliveryConfig.estimatedDeliveryTimeMax || ETA_DEFAULT.max,
			}
		: ETA_DEFAULT

	return c.json(
		{
			status: 'deliverable',
			quote: {
				token,
				expiresAt: expiresAt.toISOString(),
				address,
				zoneId: zone.id,
				zoneName: zone.name,
				deliveryFee: zone.deliveryFee,
				minimumOrder: zone.minimumOrder,
				eta,
			},
		},
		200,
		noStore(),
	)
})
