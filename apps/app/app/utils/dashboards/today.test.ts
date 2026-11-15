import { describe, expect, it } from 'vitest'
import {
	ALL_LOCATIONS,
	averageOrderMinor,
	compareSales,
	homeLocationStorageKey,
	selectedLocations,
	todayQuery,
	todayTotalsSchema,
	totalOrders,
} from './today.ts'

const locations = [
	{ id: 'loc_ny', name: 'New York', timeZone: 'America/New_York' },
	{ id: 'loc_ruh', name: 'Riyadh', timeZone: 'Asia/Riyadh' },
]

describe('selectedLocations', () => {
	it('starts at all locations and falls back to all for a stale choice', () => {
		expect(selectedLocations(locations, ALL_LOCATIONS)).toEqual(locations)
		expect(selectedLocations(locations, null)).toEqual(locations)
		expect(selectedLocations(locations, 'loc_gone')).toEqual(locations)
		expect(selectedLocations(locations, 'loc_ruh')).toEqual([locations[1]])
	})
})

describe('todayQuery', () => {
	it('sends each location with its own zone, so each counts its own day', () => {
		const query = new URLSearchParams(todayQuery(locations))
		expect(query.get('locationIds')).toBe('loc_ny,loc_ruh')
		expect(query.get('timeZones')).toBe('America/New_York,Asia/Riyadh')
	})
})

describe('compareSales', () => {
	const earlier = [{ currency: 'USD', salesMinor: 2000, orders: 2 }]

	it('compares one currency with the same currency only', () => {
		expect(compareSales(3000, earlier, 'USD')).toEqual({
			kind: 'change',
			percent: 50,
		})
		// No SAR sales then: never a percentage against another currency.
		expect(compareSales(3000, earlier, 'SAR')).toEqual({ kind: 'none' })
	})

	it('says there were no sales then instead of dividing by zero', () => {
		expect(compareSales(500, [], 'USD')).toEqual({ kind: 'none' })
		expect(
			compareSales(500, [{ currency: 'USD', salesMinor: 0, orders: 0 }], 'USD'),
		).toEqual({ kind: 'none' })
	})
})

describe('order figures', () => {
	it('averages per currency and counts orders across currencies', () => {
		const rows = [
			{ currency: 'SAR', salesMinor: 9000, orders: 3 },
			{ currency: 'USD', salesMinor: 2500, orders: 2 },
		]
		expect(averageOrderMinor(rows[0]!)).toBe(3000)
		expect(
			averageOrderMinor({ currency: 'USD', salesMinor: 0, orders: 0 }),
		).toBeNull()
		expect(totalOrders(rows)).toBe(5)
	})
})

describe('todayTotalsSchema', () => {
	it('keeps totals only and drops anything else the region might send', () => {
		const parsed = todayTotalsSchema.parse({
			today: [{ currency: 'USD', salesMinor: 100, orders: 1, contact: 'x' }],
			yesterday: [],
			lastWeek: [],
			guests: { total: 1, firstTime: 1, returning: 0, names: ['Ada'] },
		})
		expect(JSON.stringify(parsed)).not.toContain('Ada')
		expect(JSON.stringify(parsed)).not.toContain('contact')
	})
})

describe('homeLocationStorageKey', () => {
	it('remembers the picker per user and organization', () => {
		expect(homeLocationStorageKey('user_1', 'org_1')).not.toBe(
			homeLocationStorageKey('user_2', 'org_1'),
		)
		expect(homeLocationStorageKey('user_1', 'org_1')).not.toBe(
			homeLocationStorageKey('user_1', 'org_2'),
		)
	})
})
