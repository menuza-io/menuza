import { Hono, type Context } from 'hono'
import { LRUCache } from 'lru-cache'

import {
	deliveryFeeFromPricing,
	deliveryPricingFor,
	distanceForZone,
	type DeliveryFeePricing,
} from '@repo/common/delivery-fees'
import {
	deliveryTravelMinutes,
	isLocationOpenForOrdering,
	locationDeliveryArrivalMinutes,
} from '@repo/common/location-availability'
import {
	locationCountryCode,
	resolveDeliveryZoneForPoint,
	type PublicLocationContext,
} from '@repo/common/restaurant-orders'
import {
	GeocoderError,
	haversineMeters,
	hasRealCoordinates,
	RouterError,
	type GeoAddress,
} from '@repo/geo'
import { z } from 'zod'

import {
	DELIVERY_QUOTE_TTL_MS,
	signDeliveryQuote,
} from '../lib/delivery-quote-token.ts'
import { getGeocoder } from '../lib/geocoder.ts'
import { rateLimitByKey } from '../lib/rate-limit.ts'
import { getNodeRegion } from '../lib/region.ts'
import { getRouter } from '../lib/router.ts'
import { findSavedAddress } from '../services/customer-addresses-service.ts'
import { fetchOrderContext } from '../services/order-service.ts'
import { authenticateCustomer } from './auth.ts'
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
	const organization = await resolveOrderingOrganization(
		c,
		{ slug: query.slug, host: query.host },
		{ allowCustomerToken: true },
	)
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
// Coverage + fee for one location (shared by the quote, the store picker and
// the operator's Address check)
// ---------------------------------------------------------------------------

export type QuoteAddress = {
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

type UnavailableReason =
	| 'delivery_disabled'
	| 'geocoding_unavailable'
	| 'store_location_missing'
	| 'no_zones'

/** Whether a location delivers at all: delivery on and an enabled allowed zone of its own. */
function deliveryOffered(
	location: PublicLocationContext,
): UnavailableReason | null {
	if (!location.fulfillmentOptions.delivery) return 'delivery_disabled'
	const hasAllowedZone = (location.deliveryZones ?? []).some(
		(zone) =>
			zone.enabled &&
			zone.restriction === 'allowed' &&
			zone.provider === 'in_house',
	)
	return hasAllowedZone ? null : 'no_zones'
}

export type QuoteQuote = {
	token?: string
	expiresAt?: string
	address: QuoteAddress
	zoneId: string
	zoneName: string
	/** The fee at the subtotal asked about (the zone's minimum when none was given). */
	deliveryFee: number
	minimumOrder: number
	eta: { min: number; max: number }
	/**
	 * What the client needs to price the cart as it changes (#244, #421): the fee
	 * for this address and the table by order size. Worked out with
	 * `deliveryFeeFromPricing`, the same rule the region uses at placement.
	 */
	pricing: DeliveryFeePricing
	/** How far the address is from the store, when the store has coordinates. */
	distance: { meters: number; source: 'driving' | 'straight_line' } | null
}

export type CoverageOutcome =
	| { status: 'deliverable'; quote: QuoteQuote }
	| {
			status: 'out_of_range'
			reason: 'out_of_range' | 'excluded'
			/** The Not allowed zone that excluded the address. */
			excludedBy?: string
			address: QuoteAddress
	  }
	| { status: 'unavailable'; reason: UnavailableReason }

/**
 * Coverage and fee for a geocoded address at one location. Routing is asked only
 * when the winning zone prices by road distance, and a failure there is never an
 * error: the straight-line distance prices the order instead. Nothing here logs
 * a coordinate, an address or a distance.
 */
export async function evaluateDelivery(
	orgId: string,
	location: PublicLocationContext,
	place: GeoAddress,
	options: {
		unit: string | null
		/** Items subtotal in major units, when the caller knows the cart. */
		subtotal?: number | null
		/** Sign a token the order can be placed with. */
		sign: boolean
		now?: Date
	},
): Promise<CoverageOutcome> {
	const unavailableReason = deliveryOffered(location)
	if (unavailableReason) {
		return { status: 'unavailable', reason: unavailableReason }
	}
	const address = quoteAddress(place, options.unit)
	const coverage = resolveDeliveryZoneForPoint(location, {
		lat: place.lat,
		lng: place.lng,
		postalCode: place.postalCode || null,
	})
	if (!coverage.ok) {
		if (coverage.reason === 'out_of_range' || coverage.reason === 'excluded') {
			return {
				status: 'out_of_range',
				reason: coverage.reason,
				...(coverage.zone ? { excludedBy: coverage.zone.name } : {}),
				address,
			}
		}
		return { status: 'unavailable', reason: coverage.reason }
	}
	const zone = coverage.zone

	const store = hasRealCoordinates(location.address)
		? { lat: location.address.lat, lng: location.address.lng }
		: null
	const straightMeters = store
		? haversineMeters(store, { lat: place.lat, lng: place.lng })
		: null
	let drivingMeters: number | null = null
	if (zone.distanceFees?.mode === 'driving' && store) {
		const router = getRouter()
		if (router) {
			try {
				const route = await router.drivingDistance(store, {
					lat: place.lat,
					lng: place.lng,
				})
				drivingMeters = route ? Math.round(route.meters) : null
			} catch (error) {
				// Only the provider and the failure class: never a coordinate.
				console.error(
					`Driving distance failed for org ${orgId} (${router.name}):`,
					error instanceof RouterError ? 'routing_failed' : 'unexpected error',
				)
			}
		}
	}
	const distance = distanceForZone(zone, { straightMeters, drivingMeters })
	const pricing = deliveryPricingFor(zone, distance?.meters ?? null)
	const eta = deliveryTravelMinutes(location)
	const quoteBase = {
		address,
		zoneId: zone.id,
		zoneName: zone.name,
		deliveryFee: deliveryFeeFromPricing(
			pricing,
			options.subtotal ?? zone.minimumOrder,
		),
		minimumOrder: zone.minimumOrder,
		// The delivery time range alone (travel, no prep, no busy minutes): Sites
		// adds the schedule lead to it, and shows the guest the ASAP window
		// `locationDeliveryArrivalMinutes(location, now, { travel: eta })` (prep +
		// busy + this range), the same rule the order's promised time uses.
		eta,
		pricing,
		distance: distance
			? { meters: Math.round(distance.meters), source: distance.source }
			: null,
	}
	if (!options.sign) return { status: 'deliverable', quote: quoteBase }

	const expiresAt = new Date(
		(options.now ?? new Date()).getTime() + DELIVERY_QUOTE_TTL_MS,
	)
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
		unit: options.unit,
		drivingMeters,
		exp: expiresAt.getTime(),
	})
	return {
		status: 'deliverable',
		quote: { ...quoteBase, token, expiresAt: expiresAt.toISOString() },
	}
}

/** The geocode of a quote or store-picker request, shared by both routes. */
async function geocodeRequest(
	orgId: string,
	body: { placeId?: string; address?: string; sessionToken?: string },
	location: PublicLocationContext,
	language: string,
): Promise<
	| { ok: true; place: GeoAddress }
	| { ok: false; status: 'not_found' | 'geocoding_unavailable' }
> {
	const geocoder = getGeocoder()
	if (!geocoder) return { ok: false, status: 'geocoding_unavailable' }
	let place: GeoAddress | null
	try {
		place = body.placeId
			? await geocoder.placeDetails(body.placeId, {
					sessionToken: body.sessionToken,
					language,
				})
			: await geocoder.geocode(body.address!, {
					country: locationCountryCode(location),
					language,
				})
	} catch (error) {
		console.error(
			`Delivery geocoding failed for org ${orgId} (${geocoder.name}):`,
			error instanceof GeocoderError ? error.message : 'unexpected error',
		)
		return { ok: false, status: 'geocoding_unavailable' }
	}
	if (!place || !hasRealCoordinates(place)) {
		return { ok: false, status: 'not_found' }
	}
	return { ok: true, place }
}

/**
 * The operator's Address check (#266): the same coverage and fee a guest would
 * get, for one location, from the operator's browser. Nothing is signed and
 * nothing is stored.
 */
export async function checkDeliveryAddress(
	orgId: string,
	locationId: string,
	body: {
		placeId?: string
		address?: string
		sessionToken?: string
		subtotal?: number | null
		locale?: string
	},
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; failure: { status: number; code: string; message: string } }
> {
	const loaded = await loadLocation(orgId, locationId)
	if (!loaded.ok) return { ok: false, failure: loaded.error }
	const { location } = loaded
	const offered = deliveryOffered(location)
	if (offered)
		return { ok: true, body: { status: 'unavailable', reason: offered } }
	const geocoded = await geocodeRequest(
		orgId,
		body,
		location,
		languageFrom(body.locale),
	)
	if (!geocoded.ok) {
		return geocoded.status === 'not_found'
			? { ok: true, body: { status: 'not_found' } }
			: {
					ok: true,
					body: { status: 'unavailable', reason: 'geocoding_unavailable' },
				}
	}
	const outcome = await evaluateDelivery(orgId, location, geocoded.place, {
		unit: null,
		subtotal: body.subtotal ?? null,
		sign: false,
	})
	return { ok: true, body: outcome }
}

/**
 * Station phone-order address autocomplete (#164): bound strictly to the
 * terminal's location, sending the address directly from Station to the
 * regional node to the geocoder only.
 */
export async function autocompleteDeliveryPlacesForLocation(
	orgId: string,
	locationId: string,
	input: { q: string; sessionToken?: string; locale?: string },
): Promise<
	| { ok: true; suggestions: unknown[] }
	| { ok: false; failure: { status: number; code: string; message: string } }
> {
	const trimmed = input.q.trim()
	if (trimmed.length < 3) return { ok: true, suggestions: [] }
	const cacheKey = `${orgId}:${locationId}`
	let info = locationGeoCache.get(cacheKey)
	if (!info) {
		const loaded = await loadLocation(orgId, locationId)
		if (!loaded.ok) return { ok: false, failure: loaded.error }
		info = geoInfoFor(loaded.location)
		locationGeoCache.set(cacheKey, info)
	}
	if (!info.deliveryEnabled) {
		return {
			ok: false,
			failure: {
				status: 422,
				code: 'delivery_disabled',
				message: 'Delivery is not enabled at this location.',
			},
		}
	}
	try {
		const geocoder = getGeocoder()
		if (!geocoder) {
			return {
				ok: false,
				failure: {
					status: 503,
					code: 'geocoding_unavailable',
					message: 'Address lookup is not configured.',
				},
			}
		}
		const suggestions = await geocoder.autocomplete(trimmed, {
			country: info.country,
			bias: info.bias ?? undefined,
			language: languageFrom(input.locale),
			sessionToken: input.sessionToken,
		})
		return { ok: true, suggestions }
	} catch (error) {
		if (error instanceof GeocoderError) {
			return {
				ok: false,
				failure: {
					status: 503,
					code: 'geocoding_unavailable',
					message: 'Address lookup is temporarily unavailable.',
				},
			}
		}
		throw error
	}
}

/**
 * Station phone-order delivery quote (#164): uses the exact same zones,
 * minimum, hours, and signed quote token as online delivery, bound to the
 * terminal's location only.
 */
export async function quoteDeliveryForPosLocation(
	orgId: string,
	locationId: string,
	body: {
		placeId?: string
		address?: string
		unit?: string
		sessionToken?: string
		locale?: string
		subtotal?: number
	},
): Promise<
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; failure: { status: number; code: string; message: string } }
> {
	const loaded = await loadLocation(orgId, locationId)
	if (!loaded.ok) return { ok: false, failure: loaded.error }
	const { location } = loaded
	const offered = deliveryOffered(location)
	if (offered) {
		return { ok: true, body: { status: 'unavailable', reason: offered } }
	}
	const geocoded = await geocodeRequest(
		orgId,
		body,
		location,
		languageFrom(body.locale),
	)
	if (!geocoded.ok) {
		return geocoded.status === 'not_found'
			? { ok: true, body: { status: 'not_found' } }
			: {
					ok: true,
					body: { status: 'unavailable', reason: 'geocoding_unavailable' },
				}
	}
	const outcome = await evaluateDelivery(orgId, location, geocoded.place, {
		unit: body.unit ?? null,
		subtotal: body.subtotal ?? null,
		sign: true,
	})
	return { ok: true, body: outcome as Record<string, unknown> }
}

/**
 * The signed-in guest's saved address as a geocoded place (#113): the point a
 * successful geocode saved, no geocoder call. The customer token is required
 * and must belong to the organization this origin names; a missing id and
 * another guest's id answer the same 404.
 */
async function savedAddressPlace(
	c: Context,
	orgId: string,
	addressId: string,
): Promise<
	| {
			ok: true
			place: GeoAddress
			saved: {
				id: string
				label: string
				notes: string | null
				unit: string | null
			}
	  }
	| { ok: false; response: Response }
> {
	let auth: Awaited<ReturnType<typeof authenticateCustomer>>
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return { ok: false, response }
		throw response
	}
	const notFound = () =>
		c.json(
			{ error: 'address_not_found', message: 'Address not found.' },
			404,
			noStore(),
		)
	// The token's organization must be the one this origin names.
	if (auth.orgId !== orgId) return { ok: false, response: notFound() }
	const saved = await findSavedAddress(auth.db, auth.customerId, addressId)
	if (!saved) return { ok: false, response: notFound() }
	return {
		ok: true,
		place: {
			formatted: saved.formatted,
			line1: saved.line1,
			city: saved.city,
			state: saved.state ?? '',
			postalCode: saved.postalCode ?? '',
			country: saved.country ?? '',
			lat: saved.lat,
			lng: saved.lng,
			placeId: '',
		},
		saved: {
			id: saved.id,
			label: saved.label,
			notes: saved.notes,
			unit: saved.unit,
		},
	}
}

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
		/**
		 * A saved address of the signed-in guest (#113): quoted again against the
		 * zones and fees as they are now, from the point a successful geocode saved.
		 * Needs the customer token; another guest's id answers 404.
		 */
		addressId: z.string().trim().min(1).max(128).optional(),
		unit: z.string().trim().max(50).optional(),
		sessionToken: z.string().trim().min(1).max(100).optional(),
		locale: z.string().max(20).optional(),
		/** The items subtotal in major units, so the fee shown fits the cart. */
		subtotal: z.number().min(0).max(1_000_000).optional(),
	})
	.refine(
		(value) => Boolean(value.placeId || value.address || value.addressId),
		{
			message: 'Choose an address',
			path: ['address'],
		},
	)

function unavailable(c: Context, reason: UnavailableReason) {
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
	const organization = await resolveOrderingOrganization(
		c,
		{ slug: body.slug, host: body.host },
		{ allowCustomerToken: true },
	)
	if ('error' in organization) return organization.error
	const orgId = organization.organization.id

	const limited = orgLimited(c, 'delivery-quote-org', orgId, 600)
	if (limited) return limited

	const loaded = await loadLocation(orgId, body.locationId)
	if (!loaded.ok) return failureResponse(c, loaded.error)
	const { location } = loaded

	const offered = deliveryOffered(location)
	if (offered) return unavailable(c, offered)

	// A saved address (#113): the guest's own row, re-quoted from the stored
	// point. No geocoder is called; the zones, minimum and fee are the current
	// ones, so an address outside every zone today answers `out_of_range`.
	if (body.addressId) {
		const resolved = await savedAddressPlace(c, orgId, body.addressId)
		if (!resolved.ok) return resolved.response
		const outcome = await evaluateDelivery(orgId, location, resolved.place, {
			unit: body.unit || resolved.saved.unit || null,
			subtotal: body.subtotal ?? null,
			sign: true,
		})
		return c.json(
			{
				...outcome,
				savedAddress: {
					id: resolved.saved.id,
					label: resolved.saved.label,
					notes: resolved.saved.notes,
				},
			},
			200,
			noStore(),
		)
	}

	const geocoded = await geocodeRequest(
		orgId,
		body,
		location,
		languageFrom(body.locale),
	)
	if (!geocoded.ok) {
		return geocoded.status === 'not_found'
			? c.json({ status: 'not_found' }, 200, noStore())
			: unavailable(c, 'geocoding_unavailable')
	}
	const outcome = await evaluateDelivery(orgId, location, geocoded.place, {
		unit: body.unit || null,
		subtotal: body.subtotal ?? null,
		sign: true,
	})
	return c.json(outcome, 200, noStore())
})

// ---------------------------------------------------------------------------
// POST /delivery/locations — which store serves this address (#161)
// ---------------------------------------------------------------------------

/** Most locations one search looks at; a brand with more gets its nearest 25 by list order. */
export const DELIVERY_LOCATIONS_CAP = 25

const locationsBodySchema = z
	.strictObject({
		slug: z.string().trim().min(1).max(100).optional(),
		host: z.string().trim().min(1).max(253).optional(),
		/** `delivery` ranks the stores that deliver here; `pickup` sorts by distance. */
		purpose: z.enum(['delivery', 'pickup']).default('delivery'),
		placeId: z.string().trim().min(1).max(512).optional(),
		address: z.string().trim().min(3).max(300).optional(),
		/** The browser's own location, for "Nearest to you" on pickup. Never stored or logged. */
		point: z
			.strictObject({
				lat: z.number().min(-90).max(90),
				lng: z.number().min(-180).max(180),
			})
			.optional(),
		/** A saved address of the signed-in guest (#113); needs the customer token. */
		addressId: z.string().trim().min(1).max(128).optional(),
		unit: z.string().trim().max(50).optional(),
		sessionToken: z.string().trim().min(1).max(100).optional(),
		locale: z.string().max(20).optional(),
		subtotal: z.number().min(0).max(1_000_000).optional(),
	})
	.refine(
		(value) =>
			Boolean(value.placeId || value.address || value.addressId) ||
			(value.purpose === 'pickup' && Boolean(value.point)),
		{ message: 'Choose an address', path: ['address'] },
	)

export type RankedLocation = {
	locationId: string
	name: string
	formattedAddress: string | null
	/** Straight-line distance from the address to the store, meters. Null without store coordinates. */
	distanceMeters: number | null
	/** False when the store is closed now but takes scheduled orders. */
	open: boolean
	/** Prep, busy and delivery minutes now (delivery purpose only). */
	etaMinutes: { min: number; max: number } | null
	quote: QuoteQuote | null
}

/**
 * Ranking (#161): stores that deliver first, then the lowest fee, the shortest
 * estimate and the nearest. Stable on ties, so the brand's own list order breaks
 * a dead heat.
 */
export function rankDeliveryLocations(
	locations: readonly RankedLocation[],
): RankedLocation[] {
	const number = (value: number | null) => value ?? Number.POSITIVE_INFINITY
	return locations
		.map((location, index) => ({ location, index }))
		.sort((a, b) => {
			const aDelivers = a.location.quote ? 0 : 1
			const bDelivers = b.location.quote ? 0 : 1
			if (aDelivers !== bDelivers) return aDelivers - bDelivers
			const fee =
				number(a.location.quote?.deliveryFee ?? null) -
				number(b.location.quote?.deliveryFee ?? null)
			if (fee !== 0 && Number.isFinite(fee)) return fee
			const eta =
				number(a.location.etaMinutes?.max ?? null) -
				number(b.location.etaMinutes?.max ?? null)
			if (eta !== 0 && Number.isFinite(eta)) return eta
			const near =
				number(a.location.distanceMeters) - number(b.location.distanceMeters)
			if (near !== 0 && Number.isFinite(near)) return near
			return a.index - b.index
		})
		.map((entry) => entry.location)
}

/**
 * A store is offered while it is open for ordering now, or closed but taking
 * scheduled orders. A paused store is never offered, and neither is one with
 * ordering switched off; pause and busy mode are per location.
 */
function offeredNow(
	location: PublicLocationContext,
	purpose: 'delivery' | 'pickup',
	now: Date,
): { open: boolean } | null {
	if (location.isActive === false) return null
	const fulfillment =
		purpose === 'delivery'
			? location.fulfillmentOptions.delivery
			: location.fulfillmentOptions.pickup
	if (!fulfillment) return null
	const availability = isLocationOpenForOrdering(location, now)
	if (availability.paused) return null
	if (availability.isOpen) return { open: true }
	return location.scheduling?.scheduledOrdersEnabled === false
		? null
		: { open: false }
}

publicDeliveryRoutes.post('/locations', async (c) => {
	const rawBody = await c.req.json().catch(() => null)
	const parsed = locationsBodySchema.safeParse(rawBody)
	if (!parsed.success) {
		return c.json(
			{
				error: 'invalid_request',
				message: parsed.error.issues[0]?.message ?? 'Invalid request',
			},
			400,
			noStore(),
		)
	}
	const body = parsed.data
	const organization = await resolveOrderingOrganization(
		c,
		{ slug: body.slug, host: body.host },
		{ allowCustomerToken: true },
	)
	if ('error' in organization) return organization.error
	const orgId = organization.organization.id

	const limited = orgLimited(c, 'delivery-quote-org', orgId, 600)
	if (limited) return limited

	// One read of the order context for every location.
	const context = await fetchOrderContext(orgId, null, null)
	if (!context.ok) return failureResponse(c, context.failure)
	if (getNodeRegion() !== context.data.dataRegion) {
		return failureResponse(c, {
			status: 503,
			code: 'ordering_unavailable',
			message: 'Ordering is temporarily unavailable. Please try again shortly.',
		})
	}
	const now = new Date()
	const all = context.data.menu.locations.slice(0, DELIVERY_LOCATIONS_CAP)
	const candidates = all.flatMap((location) => {
		const offered = offeredNow(location, body.purpose, now)
		return offered ? [{ location, open: offered.open }] : []
	})
	if (candidates.length === 0) {
		return c.json({ status: 'ok', locations: [] }, 200, noStore())
	}

	// One geocode per search, whatever the number of stores; a browser location
	// needs none.
	let point: { lat: number; lng: number; place: GeoAddress | null }
	let savedUnit: string | null = null
	if (body.addressId) {
		const resolved = await savedAddressPlace(c, orgId, body.addressId)
		if (!resolved.ok) return resolved.response
		savedUnit = resolved.saved.unit
		point = {
			lat: resolved.place.lat,
			lng: resolved.place.lng,
			place: resolved.place,
		}
	} else if (body.point && !body.placeId && !body.address) {
		point = { ...body.point, place: null }
	} else {
		const geocoded = await geocodeRequest(
			orgId,
			body,
			candidates[0]!.location,
			languageFrom(body.locale),
		)
		if (!geocoded.ok) {
			return geocoded.status === 'not_found'
				? c.json({ status: 'not_found' }, 200, noStore())
				: unavailable(c, 'geocoding_unavailable')
		}
		point = {
			lat: geocoded.place.lat,
			lng: geocoded.place.lng,
			place: geocoded.place,
		}
	}

	const ranked: RankedLocation[] = []
	for (const { location, open } of candidates) {
		const store = hasRealCoordinates(location.address)
			? { lat: location.address.lat, lng: location.address.lng }
			: null
		const distanceMeters = store
			? Math.round(haversineMeters(store, point))
			: null
		const base = {
			locationId: location.id,
			name: location.name,
			formattedAddress: location.address?.formattedAddress ?? null,
			distanceMeters,
			open,
		}
		if (body.purpose === 'pickup') {
			ranked.push({ ...base, etaMinutes: null, quote: null })
			continue
		}
		if (!point.place) continue
		const outcome = await evaluateDelivery(orgId, location, point.place, {
			unit: body.unit || savedUnit || null,
			subtotal: body.subtotal ?? null,
			sign: true,
			now,
		})
		if (outcome.status !== 'deliverable') continue
		ranked.push({
			...base,
			etaMinutes: locationDeliveryArrivalMinutes(location, now, {
				travel: outcome.quote.eta,
			}),
			quote: outcome.quote,
		})
	}

	const locations =
		body.purpose === 'pickup'
			? [...ranked].sort(
					(a, b) =>
						(a.distanceMeters ?? Number.POSITIVE_INFINITY) -
						(b.distanceMeters ?? Number.POSITIVE_INFINITY),
				)
			: rankDeliveryLocations(ranked)
	return c.json({ status: 'ok', locations }, 200, noStore())
})
