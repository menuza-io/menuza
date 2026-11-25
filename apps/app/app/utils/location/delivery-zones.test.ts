import { type DeliveryZone } from '@repo/common/location-types'
import { describe, expect, it } from 'vitest'
import {
	firstZoneTableProblem,
	moveZone,
	parseZonesJson,
	zoneOverlapNotes,
	zoneTableProblemMessage,
} from './delivery-zones.ts'

const STORE = { lat: 41.8853, lng: -87.6229 }

function zone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
	return {
		id: 'z',
		name: 'Zone',
		provider: 'in_house',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'km' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 10,
		deliveryFee: 3,
		enabled: true,
		...overrides,
	}
}

describe('moveZone (#266)', () => {
	const zones = [zone({ id: 'a' }), zone({ id: 'b' }), zone({ id: 'c' })]
	it('moves a zone to the place another holds', () => {
		expect(moveZone(zones, 'c', 'a').map((z) => z.id)).toEqual(['c', 'a', 'b'])
		expect(moveZone(zones, 'a', 'c').map((z) => z.id)).toEqual(['b', 'c', 'a'])
	})
	it('leaves the list alone for unknown or identical ids', () => {
		expect(moveZone(zones, 'a', 'a').map((z) => z.id)).toEqual(['a', 'b', 'c'])
		expect(moveZone(zones, 'x', 'a').map((z) => z.id)).toEqual(['a', 'b', 'c'])
	})
})

describe('zoneOverlapNotes (#266)', () => {
	const ring = zone({ id: 'ring', name: 'Ring', radius: { value: 1, unit: 'km' }, deliveryFee: 0 })
	const wide = zone({ id: 'wide', name: 'Wide', radius: { value: 9, unit: 'km' }, deliveryFee: 6 })

	it('says which overlapping zone wins by list order', () => {
		const notes = zoneOverlapNotes([wide, ring], STORE, 'order')
		expect(notes.get('wide')?.overlaps).toEqual([
			{ id: 'ring', name: 'Ring', thisWins: true },
		])
		expect(notes.get('ring')?.overlaps).toEqual([
			{ id: 'wide', name: 'Wide', thisWins: false },
		])
		// Reordered, the other one wins.
		const swapped = zoneOverlapNotes([ring, wide], STORE, 'order')
		expect(swapped.get('ring')?.overlaps[0]?.thisWins).toBe(true)
	})

	it('says the cheaper one wins while the location is untouched', () => {
		const notes = zoneOverlapNotes([wide, ring], STORE, 'cheapest')
		expect(notes.get('ring')?.overlaps[0]?.thisWins).toBe(true)
		expect(notes.get('wide')?.overlaps[0]?.thisWins).toBe(false)
	})

	it('ignores disabled and Not allowed zones, and zones that do not overlap', () => {
		const notes = zoneOverlapNotes(
			[
				wide,
				{ ...ring, enabled: false },
				zone({ id: 'blocked', restriction: 'disallowed' }),
			],
			STORE,
			'order',
		)
		expect(notes.size).toBe(0)
		expect(zoneOverlapNotes([wide, ring], null, 'order').size).toBe(0)
	})
})

describe('fee table checks on save (#244, #421)', () => {
	it('accepts zones without tables and valid ones', () => {
		expect(firstZoneTableProblem([zone()])).toBeNull()
		expect(
			firstZoneTableProblem([
				zone({
					feeSteps: [
						{ from: 10, fee: 5 },
						{ from: 20, fee: 0 },
					],
					distanceFees: {
						mode: 'driving',
						unit: 'km',
						bands: [
							{ from: 0, fee: 3 },
							{ from: 5, fee: 5 },
						],
					},
				}),
			]),
		).toBeNull()
	})

	it('names the zone and what is wrong', () => {
		const duplicate = firstZoneTableProblem([
			zone({
				name: 'Downtown',
				feeSteps: [
					{ from: 10, fee: 5 },
					{ from: 10, fee: 4 },
				],
			}),
		])
		expect(duplicate).toEqual({ zoneName: 'Downtown', problem: 'steps_not_distinct' })
		expect(zoneTableProblemMessage(duplicate!)).toBe(
			'Downtown: each fee step needs a different order amount.',
		)
		expect(
			firstZoneTableProblem([zone({ minimumOrder: 10, feeSteps: [{ from: 15, fee: 1 }] })]),
		).toMatchObject({ problem: 'steps_first_not_minimum' })
		expect(
			firstZoneTableProblem([
				zone({ distanceFees: { mode: 'driving', unit: 'km', bands: [{ from: 2, fee: 1 }] } }),
			]),
		).toMatchObject({ problem: 'bands_first_not_zero' })
		expect(
			firstZoneTableProblem([zone({ feeSteps: [{ from: -1, fee: 1 }] })]),
		).toMatchObject({ problem: 'invalid_table' })
	})

	it('reads the zones a form sent, and nothing else', () => {
		expect(parseZonesJson(JSON.stringify([zone()]))).toHaveLength(1)
		expect(parseZonesJson('{"a":1}')).toBeNull()
		expect(parseZonesJson('not json')).toBeNull()
		expect(parseZonesJson(undefined)).toBeNull()
	})
})
