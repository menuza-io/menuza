/**
 * Delivery-zone coverage math. Pure, dependency-free, and runtime-agnostic
 * (Workers + Node). Callers decide which zones are eligible (e.g. in-house
 * only); this module decides whether a point is covered and by which zone.
 */

export type LatLng = { lat: number; lng: number }

export type CoverageZone = {
	id: string
	name: string
	restriction: 'allowed' | 'disallowed'
	type: 'radius' | 'zip_code' | 'polygon'
	radius?: { value: number; unit: 'miles' | 'km' } | null
	zipCodes?: string[] | null
	polygon?: LatLng[] | null
	minimumOrder: number
	deliveryFee: number
	enabled: boolean
}

export type CoverageLocation<Z extends CoverageZone = CoverageZone> = {
	address?: { lat?: number | null; lng?: number | null } | null
	deliveryZones?: Z[] | null
}

export type CoveragePoint = LatLng & { postalCode?: string | null }

export type CoverageFailureReason =
	'out_of_range' | 'excluded' | 'no_zones' | 'store_location_missing'

export type ZoneResolution<Z extends CoverageZone = CoverageZone> =
	{ ok: true; zone: Z } | { ok: false; reason: CoverageFailureReason }

const EARTH_RADIUS_METERS = 6_371_008.8
const METERS_PER_MILE = 1609.344
const METERS_PER_KM = 1000

function toRadians(degrees: number) {
	return (degrees * Math.PI) / 180
}

/** Great-circle distance in meters between two WGS84 points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
	const dLat = toRadians(b.lat - a.lat)
	const dLng = toRadians(b.lng - a.lng)
	const lat1 = toRadians(a.lat)
	const lat2 = toRadians(b.lat)
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Ray-casting point-in-polygon on lat/lng treated as a plane. Accurate for
 * city-scale delivery polygons (not for polygons spanning the antimeridian).
 * Polygons with fewer than three vertices never contain anything.
 */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
	if (!Array.isArray(polygon) || polygon.length < 3) return false
	let inside = false
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i]!
		const b = polygon[j]!
		const crosses =
			a.lat > point.lat !== b.lat > point.lat &&
			point.lng <
				((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
		if (crosses) inside = !inside
	}
	return inside
}

function isFiniteCoordinate(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * A usable store coordinate: finite, in range, and not the 0,0 placeholder
 * that unconfigured locations are saved with.
 */
export function hasRealCoordinates(
	value: { lat?: number | null; lng?: number | null } | null | undefined,
): value is LatLng {
	if (!value) return false
	const { lat, lng } = value
	if (!isFiniteCoordinate(lat) || !isFiniteCoordinate(lng)) return false
	if (lat === 0 && lng === 0) return false
	return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/** Uppercase alphanumerics only, so "M5V 2T6" == "m5v2t6" and "60601-1234" == "606011234". */
export function normalizePostalCode(value: string): string {
	return toAsciiDigits(value)
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
}

/** Converts Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
export function toAsciiDigits(value: string): string {
	return value
		.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
}

function postalMatches(zoneCodes: string[], postalCode: string): boolean {
	const normalized = normalizePostalCode(postalCode)
	if (!normalized) return false
	// US ZIP+4 ("606011234") also matches its 5-digit zone ("60601").
	const zip5 = /^\d{9}$/.test(normalized) ? normalized.slice(0, 5) : null
	return zoneCodes.some((code) => {
		const zoneCode = normalizePostalCode(code)
		return zoneCode !== '' && (zoneCode === normalized || zoneCode === zip5)
	})
}

function radiusMeters(zone: CoverageZone): number | null {
	const radius = zone.radius
	if (!radius || !isFiniteCoordinate(radius.value) || radius.value <= 0) {
		return null
	}
	return radius.value * (radius.unit === 'km' ? METERS_PER_KM : METERS_PER_MILE)
}

type ZoneMatch = 'match' | 'no_match' | 'store_location_missing' | 'invalid'

function matchZone(
	zone: CoverageZone,
	point: CoveragePoint,
	store: LatLng | null,
): ZoneMatch {
	switch (zone.type) {
		case 'radius': {
			const meters = radiusMeters(zone)
			if (meters == null) return 'invalid'
			if (!store) return 'store_location_missing'
			return haversineMeters(store, point) <= meters ? 'match' : 'no_match'
		}
		case 'polygon': {
			const polygon = zone.polygon ?? []
			if (polygon.length < 3) return 'invalid'
			return pointInPolygon(point, polygon) ? 'match' : 'no_match'
		}
		case 'zip_code': {
			const codes = zone.zipCodes ?? []
			if (codes.length === 0) return 'invalid'
			if (!point.postalCode) return 'no_match'
			return postalMatches(codes, point.postalCode) ? 'match' : 'no_match'
		}
		default:
			return 'invalid'
	}
}

function cheaper(a: CoverageZone, b: CoverageZone): boolean {
	if (a.deliveryFee !== b.deliveryFee) return a.deliveryFee < b.deliveryFee
	return a.minimumOrder < b.minimumOrder
}

/**
 * Resolves the delivery zone covering a point.
 *
 * - Only `enabled` zones count.
 * - `disallowed` zones are exclusions: a point inside any of them is
 *   `excluded`, even if an allowed zone also covers it.
 * - Radius zones are centred on the store (`location.address`); a missing or
 *   0,0 store coordinate makes them unverifiable (`store_location_missing`
 *   when nothing else matched).
 * - When several allowed zones match, the cheapest (fee, then minimum) wins.
 */
export function resolveZoneForPoint<Z extends CoverageZone>(
	location: CoverageLocation<Z>,
	point: CoveragePoint,
): ZoneResolution<Z> {
	const zones = (location.deliveryZones ?? []).filter((zone) => zone.enabled)
	const allowed = zones.filter((zone) => zone.restriction === 'allowed')
	if (allowed.length === 0) return { ok: false, reason: 'no_zones' }
	if (!hasRealCoordinates(point)) return { ok: false, reason: 'out_of_range' }

	const store = hasRealCoordinates(location.address)
		? { lat: location.address.lat, lng: location.address.lng }
		: null

	for (const zone of zones) {
		if (zone.restriction !== 'disallowed') continue
		if (matchZone(zone, point, store) === 'match') {
			return { ok: false, reason: 'excluded' }
		}
	}

	let best: Z | null = null
	let storeMissing = false
	let evaluable = false
	for (const zone of allowed) {
		const result = matchZone(zone, point, store)
		if (result === 'invalid') continue
		if (result === 'store_location_missing') {
			storeMissing = true
			continue
		}
		evaluable = true
		if (result === 'match' && (!best || cheaper(zone, best))) best = zone
	}

	if (best) return { ok: true, zone: best }
	// A radius zone we could not evaluate might have covered this point, so
	// "out of range" would be a guess: report the configuration problem.
	if (storeMissing) return { ok: false, reason: 'store_location_missing' }
	if (!evaluable) return { ok: false, reason: 'no_zones' }
	return { ok: false, reason: 'out_of_range' }
}
