import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import {
	clearDemandSourcesForTest,
	getDemandSource,
	listDemandSources,
	registerDemandSource,
	type DemandSource,
} from './demand-sources.ts'
import { getOrderSource, registerOrderSource } from './order-source.ts'
import { createFakeOrderSource } from '../../tests/order-source.ts'

const visits: DemandSource = {
	id: 'visits',
	unit: 'visits',
	loadBuckets: async () => [],
	loadBooked: async () => [],
}

beforeEach(() => {
	clearDemandSourcesForTest()
	registerOrderSource(null)
})
afterEach(() => {
	clearDemandSourcesForTest()
	registerOrderSource(null)
})

describe('demand source registry', () => {
	it('starts empty and lists orders first, then the rest by id', () => {
		expect(listDemandSources()).toEqual([])
		registerDemandSource({ ...visits, id: 'visits' })
		registerDemandSource({ ...visits, id: 'a_other' })
		registerOrderSource(createFakeOrderSource('loc').source)
		expect(listDemandSources().map((s) => s.id)).toEqual([
			'orders',
			'a_other',
			'visits',
		])
	})

	it('registers visits without disturbing orders or the order slot (VAL-FCST-001)', () => {
		const catalogWithout = activeReportCatalog()
		registerDemandSource(visits)
		// The order slot (and so labor sales and the report wording) is untouched.
		expect(getOrderSource()).toBeNull()
		expect(activeReportCatalog()).toBe(catalogWithout)

		const fake = createFakeOrderSource('loc').source
		registerOrderSource(fake)
		expect(getOrderSource()).toBe(fake)
		const withOrders = activeReportCatalog()
		registerDemandSource({ ...visits })
		expect(getOrderSource()).toBe(fake)
		expect(activeReportCatalog()).toBe(withOrders)
		expect(getDemandSource('orders')?.unit).toBe('orders')
		expect(getDemandSource('visits')?.unit).toBe('visits')
	})

	it('removes only the orders source when the order source is cleared', () => {
		registerOrderSource(createFakeOrderSource('loc').source)
		registerDemandSource(visits)
		registerOrderSource(null)
		expect(listDemandSources().map((s) => s.id)).toEqual(['visits'])
		expect(getOrderSource()).toBeNull()
	})

	it('serves the order source as units through the orders demand source', async () => {
		const fake = createFakeOrderSource('loc')
		registerOrderSource(fake.source)
		const at = Date.UTC(2031, 0, 6, 12, 30)
		fake.add(at)
		fake.add(at, { fulfillment: 'delivery' })
		const orders = getDemandSource('orders')!
		const buckets = await orders.loadBuckets({} as never, 'loc', {
			fromSeconds: Math.floor(at / 1000) - 3600,
			toSeconds: Math.floor(at / 1000) + 3600,
			alignSeconds: 0,
		})
		// Pickup and delivery rows of the bucket become one count.
		expect(buckets).toEqual([
			{ bucket: Math.floor(Math.floor(at / 1000) / 900), units: 2 },
		])
	})
})
