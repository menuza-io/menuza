import {
	haversineMeters,
	normalizePostalCode,
	pointInPolygon,
	type CoverageZone,
	type LatLng,
} from './coverage.ts'

/**
 * Which delivery zones overlap which (#266), so the zone list can say "this one
 * wins because it is higher". Pure and approximate for geometry: two shapes
 * overlap when a vertex of one lies in the other, or when a grid of sample
 * points across their shared bounding box finds a point in both. Zip-code zones
 * have no shape, so they overlap each other only by sharing a code, and never
 * a drawn zone (the screen cannot know where a postcode lies).
 */

type OverlapZone = Pick<
	CoverageZone,
	'id' | 'type' | 'radius' | 'zipCodes' | 'polygon'
>

const METERS_PER_DEGREE_LAT = 111_320
const GRID_STEPS = 40
const METERS_PER_MILE = 1609.344

function radiusMetersOf(zone: OverlapZone): number | null {
	const radius = zone.radius
	if (!radius || !Number.isFinite(radius.value) || radius.value <= 0) {
		return null
	}
	return radius.value * (radius.unit === 'km' ? 1000 : METERS_PER_MILE)
}

type Shape = {
	contains: (point: LatLng) => boolean
	box: { minLat: number; maxLat: number; minLng: number; maxLng: number }
	vertices: LatLng[]
}

function shapeOf(zone: OverlapZone, store: LatLng | null): Shape | null {
	if (zone.type === 'radius') {
		const meters = radiusMetersOf(zone)
		if (meters == null || !store) return null
		const dLat = meters / METERS_PER_DEGREE_LAT
		const dLng =
			meters /
			(METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos((store.lat * Math.PI) / 180)))
		return {
			contains: (point) => haversineMeters(store, point) <= meters,
			box: {
				minLat: store.lat - dLat,
				maxLat: store.lat + dLat,
				minLng: store.lng - dLng,
				maxLng: store.lng + dLng,
			},
			vertices: [store],
		}
	}
	if (zone.type === 'polygon') {
		const polygon = zone.polygon ?? []
		if (polygon.length < 3) return null
		const lats = polygon.map((p) => p.lat)
		const lngs = polygon.map((p) => p.lng)
		return {
			contains: (point) => pointInPolygon(point, polygon),
			box: {
				minLat: Math.min(...lats),
				maxLat: Math.max(...lats),
				minLng: Math.min(...lngs),
				maxLng: Math.max(...lngs),
			},
			vertices: polygon,
		}
	}
	return null
}

function sharedZipCode(a: OverlapZone, b: OverlapZone): boolean {
	const codes = new Set(
		(a.zipCodes ?? []).map(normalizePostalCode).filter(Boolean),
	)
	return (b.zipCodes ?? []).some((code) => codes.has(normalizePostalCode(code)))
}

/** Whether two zones cover any common ground. `store` centres radius zones. */
export function zonesOverlap(
	a: OverlapZone,
	b: OverlapZone,
	store: LatLng | null,
): boolean {
	if (a.type === 'zip_code' && b.type === 'zip_code') return sharedZipCode(a, b)
	const first = shapeOf(a, store)
	const second = shapeOf(b, store)
	if (!first || !second) return false
	if (
		first.vertices.some((vertex) => second.contains(vertex)) ||
		second.vertices.some((vertex) => first.contains(vertex))
	) {
		return true
	}
	const minLat = Math.max(first.box.minLat, second.box.minLat)
	const maxLat = Math.min(first.box.maxLat, second.box.maxLat)
	const minLng = Math.max(first.box.minLng, second.box.minLng)
	const maxLng = Math.min(first.box.maxLng, second.box.maxLng)
	if (minLat > maxLat || minLng > maxLng) return false
	for (let i = 0; i <= GRID_STEPS; i += 1) {
		for (let j = 0; j <= GRID_STEPS; j += 1) {
			const point = {
				lat: minLat + ((maxLat - minLat) * i) / GRID_STEPS,
				lng: minLng + ((maxLng - minLng) * j) / GRID_STEPS,
			}
			if (first.contains(point) && second.contains(point)) return true
		}
	}
	return false
}

/**
 * For each zone id, the ids of the other zones it overlaps, in list order.
 * Disabled zones take no part (they are skipped when an address is checked), and
 * a zone never overlaps itself.
 */
export function zoneOverlaps(
	zones: ReadonlyArray<OverlapZone & { enabled?: boolean }>,
	store: LatLng | null,
): Map<string, string[]> {
	const result = new Map<string, string[]>()
	const active = zones.filter((zone) => zone.enabled !== false)
	for (const zone of active) {
		const others = active
			.filter((other) => other.id !== zone.id)
			.filter((other) => zonesOverlap(zone, other, store))
			.map((other) => other.id)
		if (others.length > 0) result.set(zone.id, others)
	}
	return result
}
