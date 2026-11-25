import { describe, expect, it } from 'vitest'

import {
	haversineMeters,
	hasRealCoordinates,
	normalizePostalCode,
	pointInPolygon,
	resolveZoneForPoint,
	type CoverageZone,
} from './coverage.ts'

const STORE = { lat: 41.8853, lng: -87.6229 } // 123 Demo Street, Chicago
const NEAR = { lat: 41.8789, lng: -87.6359 } // Willis Tower, ~1.3 km
const EDGE_IN = { lat: 41.9484, lng: -87.6553 } // Wrigley Field, ~7.5 km
const EDGE_OUT = { lat: 41.7886, lng: -87.5987 } // UChicago, ~10.9 km
const EVANSTON = { lat: 42.0473, lng: -87.6815 }

function zone(overrides: Partial<CoverageZone> = {}): CoverageZone {
	return {
		id: 'zone-radius',
		name: 'Standard Delivery Area',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'miles' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 15,
		deliveryFee: 3.99,
		enabled: true,
		...overrides,
	}
}

// Rough box around the Loop.
const LOOP_POLYGON = [
	{ lat: 41.9, lng: -87.65 },
	{ lat: 41.9, lng: -87.6 },
	{ lat: 41.87, lng: -87.6 },
	{ lat: 41.87, lng: -87.65 },
]

describe('haversineMeters', () => {
	it('is zero for the same point and symmetric', () => {
		expect(haversineMeters(STORE, STORE)).toBe(0)
		expect(haversineMeters(STORE, NEAR)).toBeCloseTo(
			haversineMeters(NEAR, STORE),
			6,
		)
	})

	it('matches known distances within 1%', () => {
		// Chicago Loop → Evanston is ~18 km.
		const meters = haversineMeters(STORE, EVANSTON)
		expect(meters).toBeGreaterThan(17_500)
		expect(meters).toBeLessThan(19_000)
		// One degree of latitude ≈ 111.2 km.
		expect(
			haversineMeters({ lat: 0, lng: 10 }, { lat: 1, lng: 10 }),
		).toBeCloseTo(111_195, -2)
	})
})

describe('pointInPolygon', () => {
	it('detects inside and outside points', () => {
		expect(pointInPolygon(STORE, LOOP_POLYGON)).toBe(true)
		expect(pointInPolygon(EVANSTON, LOOP_POLYGON)).toBe(false)
	})

	it('handles concave polygons', () => {
		// "U" shape: the notch in the middle is outside.
		const u = [
			{ lat: 0, lng: 0 },
			{ lat: 0, lng: 3 },
			{ lat: 3, lng: 3 },
			{ lat: 3, lng: 2 },
			{ lat: 1, lng: 2 },
			{ lat: 1, lng: 1 },
			{ lat: 3, lng: 1 },
			{ lat: 3, lng: 0 },
		]
		expect(pointInPolygon({ lat: 2, lng: 0.5 }, u)).toBe(true)
		expect(pointInPolygon({ lat: 2, lng: 1.5 }, u)).toBe(false)
		expect(pointInPolygon({ lat: 0.5, lng: 1.5 }, u)).toBe(true)
	})

	it('never matches degenerate polygons', () => {
		expect(pointInPolygon(STORE, [])).toBe(false)
		expect(pointInPolygon(STORE, LOOP_POLYGON.slice(0, 2))).toBe(false)
	})
})

describe('hasRealCoordinates / normalizePostalCode', () => {
	it('rejects missing, 0,0, and out-of-range coordinates', () => {
		expect(hasRealCoordinates(null)).toBe(false)
		expect(hasRealCoordinates({ lat: 0, lng: 0 })).toBe(false)
		expect(hasRealCoordinates({ lat: Number.NaN, lng: 1 })).toBe(false)
		expect(hasRealCoordinates({ lat: 91, lng: 1 })).toBe(false)
		expect(hasRealCoordinates({ lat: 0, lng: 12 })).toBe(true)
		expect(hasRealCoordinates(STORE)).toBe(true)
	})

	it('normalizes spacing, case, punctuation and Arabic-Indic digits', () => {
		expect(normalizePostalCode(' m5v 2t6 ')).toBe('M5V2T6')
		expect(normalizePostalCode('60601-1234')).toBe('606011234')
		expect(normalizePostalCode('١٢٢١١')).toBe('12211')
	})
})

describe('resolveZoneForPoint', () => {
	it('covers points inside a radius zone centred on the store', () => {
		const location = { address: STORE, deliveryZones: [zone()] }
		for (const point of [STORE, NEAR, EDGE_IN]) {
			const result = resolveZoneForPoint(location, point)
			expect(result).toEqual({ ok: true, zone: location.deliveryZones[0] })
		}
	})

	it('reports out_of_range outside every zone', () => {
		const location = { address: STORE, deliveryZones: [zone()] }
		expect(resolveZoneForPoint(location, EDGE_OUT)).toEqual({
			ok: false,
			reason: 'out_of_range',
		})
		expect(resolveZoneForPoint(location, EVANSTON)).toEqual({
			ok: false,
			reason: 'out_of_range',
		})
	})

	it('supports kilometre radii', () => {
		const location = {
			address: STORE,
			deliveryZones: [zone({ radius: { value: 2, unit: 'km' } })],
		}
		expect(resolveZoneForPoint(location, NEAR).ok).toBe(true)
		expect(resolveZoneForPoint(location, EDGE_IN).ok).toBe(false)
	})

	it('reports store_location_missing for radius zones without store coordinates', () => {
		for (const address of [
			null,
			undefined,
			{ lat: 0, lng: 0 },
			{ lat: null, lng: null },
		]) {
			expect(
				resolveZoneForPoint({ address, deliveryZones: [zone()] }, NEAR),
			).toEqual({ ok: false, reason: 'store_location_missing' })
		}
	})

	it('still resolves polygon and zip zones when the store has no coordinates', () => {
		const polygon = zone({
			id: 'zone-polygon',
			type: 'polygon',
			polygon: LOOP_POLYGON,
		})
		const result = resolveZoneForPoint(
			{ address: { lat: 0, lng: 0 }, deliveryZones: [zone(), polygon] },
			NEAR,
		)
		expect(result).toEqual({ ok: true, zone: polygon })
	})

	it('evaluates polygon zones', () => {
		const location = {
			address: STORE,
			deliveryZones: [
				zone({ id: 'zone-polygon', type: 'polygon', polygon: LOOP_POLYGON }),
			],
		}
		expect(resolveZoneForPoint(location, NEAR).ok).toBe(true)
		expect(resolveZoneForPoint(location, EVANSTON)).toEqual({
			ok: false,
			reason: 'out_of_range',
		})
	})

	it('evaluates zip-code zones from the point postal code', () => {
		const zip = zone({
			id: 'zone-zip',
			type: 'zip_code',
			zipCodes: ['60201', 'M5V 2T6'],
		})
		const location = { address: STORE, deliveryZones: [zip] }
		expect(
			resolveZoneForPoint(location, { ...EVANSTON, postalCode: '60201' }),
		).toEqual({ ok: true, zone: zip })
		expect(
			resolveZoneForPoint(location, { ...EVANSTON, postalCode: '60201-4410' }),
		).toEqual({ ok: true, zone: zip })
		expect(
			resolveZoneForPoint(location, { ...EVANSTON, postalCode: 'm5v2t6' }).ok,
		).toBe(true)
		expect(
			resolveZoneForPoint(location, { ...EVANSTON, postalCode: '60202' }),
		).toEqual({ ok: false, reason: 'out_of_range' })
		expect(resolveZoneForPoint(location, EVANSTON)).toEqual({
			ok: false,
			reason: 'out_of_range',
		})
	})

	it('excludes points inside a disallowed zone even when an allowed zone covers them', () => {
		const location = {
			address: STORE,
			deliveryZones: [
				zone(),
				zone({
					id: 'zone-no-go',
					restriction: 'disallowed',
					type: 'polygon',
					polygon: [
						{ lat: 41.882, lng: -87.64 },
						{ lat: 41.882, lng: -87.63 },
						{ lat: 41.875, lng: -87.63 },
						{ lat: 41.875, lng: -87.64 },
					],
				}),
			],
		}
		expect(resolveZoneForPoint(location, NEAR)).toMatchObject({
			ok: false,
			reason: 'excluded',
			zone: { id: 'zone-no-go' },
		})
		expect(resolveZoneForPoint(location, STORE).ok).toBe(true)
	})

	it('ignores disabled zones (allowed and disallowed)', () => {
		expect(
			resolveZoneForPoint(
				{ address: STORE, deliveryZones: [zone({ enabled: false })] },
				NEAR,
			),
		).toEqual({ ok: false, reason: 'no_zones' })
		const result = resolveZoneForPoint(
			{
				address: STORE,
				deliveryZones: [
					zone(),
					zone({
						id: 'zone-off',
						restriction: 'disallowed',
						radius: { value: 50, unit: 'miles' },
						enabled: false,
					}),
				],
			},
			NEAR,
		)
		expect(result.ok).toBe(true)
	})

	it('returns no_zones when no allowed zone exists or none is checkable', () => {
		expect(
			resolveZoneForPoint({ address: STORE, deliveryZones: [] }, NEAR),
		).toEqual({ ok: false, reason: 'no_zones' })
		expect(
			resolveZoneForPoint(
				{
					address: STORE,
					deliveryZones: [zone({ restriction: 'disallowed' })],
				},
				NEAR,
			),
		).toEqual({ ok: false, reason: 'no_zones' })
		expect(
			resolveZoneForPoint(
				{
					address: STORE,
					deliveryZones: [zone({ type: 'zip_code', zipCodes: [] })],
				},
				NEAR,
			),
		).toEqual({ ok: false, reason: 'no_zones' })
	})

	it('chooses the cheapest matching zone (fee, then minimum)', () => {
		const wide = zone({
			id: 'wide',
			radius: { value: 10, unit: 'miles' },
			deliveryFee: 6,
			minimumOrder: 25,
		})
		const close = zone({
			id: 'close',
			radius: { value: 2, unit: 'miles' },
			deliveryFee: 2,
			minimumOrder: 20,
		})
		const sameFeeLowerMin = zone({
			id: 'polygon',
			type: 'polygon',
			polygon: LOOP_POLYGON,
			deliveryFee: 2,
			minimumOrder: 10,
		})
		const location = {
			address: STORE,
			deliveryZones: [wide, close, sameFeeLowerMin],
		}
		expect(resolveZoneForPoint(location, NEAR)).toEqual({
			ok: true,
			zone: sameFeeLowerMin,
		})
		expect(resolveZoneForPoint(location, EDGE_OUT)).toEqual({
			ok: true,
			zone: wide,
		})
	})

	it('treats a 0,0 customer point as uncovered', () => {
		expect(
			resolveZoneForPoint(
				{ address: STORE, deliveryZones: [zone()] },
				{ lat: 0, lng: 0 },
			),
		).toEqual({ ok: false, reason: 'out_of_range' })
	})
})

describe('resolveZoneForPoint: zone priority (#266)', () => {
	// A small free ring inside a wider paid ring: radius zones are both centred
	// on the store, so NEAR is in both.
	const ring = zone({
		id: 'ring',
		name: 'Free ring',
		radius: { value: 3, unit: 'km' },
		deliveryFee: 0,
		minimumOrder: 25,
	})
	const wide = zone({
		id: 'wide',
		name: 'Wide area',
		radius: { value: 20, unit: 'km' },
		deliveryFee: 6,
		minimumOrder: 10,
	})
	const district = zone({
		id: 'district',
		name: 'Premium district',
		type: 'polygon',
		polygon: LOOP_POLYGON,
		deliveryFee: 9,
		minimumOrder: 40,
	})

	it('keeps the cheapest zone when the location never set a priority', () => {
		const location = { address: STORE, deliveryZones: [district, wide, ring] }
		expect(resolveZoneForPoint(location, NEAR)).toEqual({ ok: true, zone: ring })
		expect(
			resolveZoneForPoint({ ...location, zonePriority: 'cheapest' }, NEAR),
		).toEqual({ ok: true, zone: ring })
	})

	it('takes the first zone in the list that covers the point in order mode', () => {
		const location = {
			address: STORE,
			deliveryZones: [district, wide, ring],
			zonePriority: 'order' as const,
		}
		// NEAR is in the polygon (listed first) and in both rings.
		expect(resolveZoneForPoint(location, NEAR)).toEqual({
			ok: true,
			zone: district,
		})
		// Reordered: the free ring first.
		expect(
			resolveZoneForPoint({ ...location, deliveryZones: [ring, wide, district] }, NEAR),
		).toEqual({ ok: true, zone: ring })
		// EDGE_IN is outside the ring and the polygon: only the wide zone covers it.
		expect(resolveZoneForPoint(location, EDGE_IN)).toEqual({
			ok: true,
			zone: wide,
		})
	})

	it('lets an explicit option override the location mode', () => {
		const location = {
			address: STORE,
			deliveryZones: [district, ring],
			zonePriority: 'order' as const,
		}
		expect(resolveZoneForPoint(location, NEAR, { priority: 'cheapest' })).toEqual({
			ok: true,
			zone: ring,
		})
	})

	it('skips disabled zones and still excludes through Not allowed zones in either mode', () => {
		const blocked = zone({
			id: 'blocked',
			name: 'Campus',
			restriction: 'disallowed',
			type: 'polygon',
			polygon: LOOP_POLYGON,
		})
		const order = { address: STORE, zonePriority: 'order' as const }
		expect(
			resolveZoneForPoint(
				{ ...order, deliveryZones: [{ ...ring, enabled: false }, wide] },
				NEAR,
			),
		).toEqual({ ok: true, zone: wide })
		// Not allowed wins whatever its position, and names itself.
		for (const zones of [
			[blocked, ring, wide],
			[ring, wide, blocked],
		]) {
			expect(
				resolveZoneForPoint({ ...order, deliveryZones: zones }, NEAR),
			).toEqual({ ok: false, reason: 'excluded', zone: blocked })
		}
	})

	it('orders zip-code zones with the others', () => {
		const zip = zone({
			id: 'zip',
			type: 'zip_code',
			zipCodes: ['60601'],
			deliveryFee: 1,
		})
		const location = {
			address: STORE,
			deliveryZones: [wide, zip],
			zonePriority: 'order' as const,
		}
		expect(
			resolveZoneForPoint(location, { ...NEAR, postalCode: '60601' }),
		).toEqual({ ok: true, zone: wide })
		expect(
			resolveZoneForPoint(
				{ ...location, deliveryZones: [zip, wide] },
				{ ...NEAR, postalCode: '60601' },
			),
		).toEqual({ ok: true, zone: zip })
	})
})
