import { describe, expect, it } from 'vitest'

import { type CoverageZone } from './coverage.ts'
import { zoneOverlaps, zonesOverlap } from './overlap.ts'

const STORE = { lat: 41.8853, lng: -87.6229 }

function zone(overrides: Partial<CoverageZone> = {}): CoverageZone {
	return {
		id: 'zone',
		name: 'Zone',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'km' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 0,
		deliveryFee: 0,
		enabled: true,
		...overrides,
	}
}

// A box a few kilometres north-west of the store, well outside a 1 km ring.
const FAR_BOX = [
	{ lat: 41.95, lng: -87.75 },
	{ lat: 41.95, lng: -87.7 },
	{ lat: 41.92, lng: -87.7 },
	{ lat: 41.92, lng: -87.75 },
]
// A box around the store.
const LOOP_BOX = [
	{ lat: 41.9, lng: -87.65 },
	{ lat: 41.9, lng: -87.6 },
	{ lat: 41.87, lng: -87.6 },
	{ lat: 41.87, lng: -87.65 },
]

describe('zonesOverlap', () => {
	it('overlaps radius zones centred on the same store', () => {
		expect(
			zonesOverlap(
				zone({ id: 'a', radius: { value: 1, unit: 'km' } }),
				zone({ id: 'b', radius: { value: 8, unit: 'km' } }),
				STORE,
			),
		).toBe(true)
	})

	it('cannot place a radius zone without store coordinates', () => {
		expect(zonesOverlap(zone({ id: 'a' }), zone({ id: 'b' }), null)).toBe(false)
	})

	it('finds a polygon that contains the ring and one that lies outside it', () => {
		const ring = zone({ id: 'ring', radius: { value: 1, unit: 'km' } })
		const around = zone({ id: 'around', type: 'polygon', polygon: LOOP_BOX })
		const away = zone({ id: 'away', type: 'polygon', polygon: FAR_BOX })
		expect(zonesOverlap(ring, around, STORE)).toBe(true)
		expect(zonesOverlap(around, ring, STORE)).toBe(true)
		expect(zonesOverlap(ring, away, STORE)).toBe(false)
	})

	it('finds two polygons that cross without sharing a vertex', () => {
		const wide = zone({
			id: 'wide',
			type: 'polygon',
			polygon: [
				{ lat: 41.9, lng: -87.7 },
				{ lat: 41.9, lng: -87.55 },
				{ lat: 41.89, lng: -87.55 },
				{ lat: 41.89, lng: -87.7 },
			],
		})
		const tall = zone({
			id: 'tall',
			type: 'polygon',
			polygon: [
				{ lat: 41.95, lng: -87.63 },
				{ lat: 41.95, lng: -87.62 },
				{ lat: 41.85, lng: -87.62 },
				{ lat: 41.85, lng: -87.63 },
			],
		})
		expect(zonesOverlap(wide, tall, STORE)).toBe(true)
	})

	it('overlaps zip-code zones only when they share a code', () => {
		const a = zone({ id: 'a', type: 'zip_code', zipCodes: ['60601', '60602'] })
		const b = zone({ id: 'b', type: 'zip_code', zipCodes: ['606 01'] })
		const c = zone({ id: 'c', type: 'zip_code', zipCodes: ['60611'] })
		expect(zonesOverlap(a, b, STORE)).toBe(true)
		expect(zonesOverlap(a, c, STORE)).toBe(false)
		// A postcode has no shape on the screen.
		expect(zonesOverlap(a, zone({ id: 'r' }), STORE)).toBe(false)
	})
})

describe('zoneOverlaps', () => {
	it('lists the zones each one overlaps and leaves out disabled ones', () => {
		const ring = zone({ id: 'ring', radius: { value: 1, unit: 'km' } })
		const wide = zone({ id: 'wide', radius: { value: 9, unit: 'km' } })
		const off = zone({ id: 'off', enabled: false })
		const away = zone({ id: 'away', type: 'polygon', polygon: FAR_BOX })
		const result = zoneOverlaps([ring, wide, off, away], STORE)
		expect(result.get('ring')).toEqual(['wide'])
		expect(result.get('wide')).toEqual(['ring', 'away'])
		expect(result.has('off')).toBe(false)
		expect(result.get('away')).toEqual(['wide'])
	})
})
