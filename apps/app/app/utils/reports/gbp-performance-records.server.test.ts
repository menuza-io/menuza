import {
	db,
	GbpDailyMetric,
	GbpLocationSync,
	GbpSearchKeyword,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	loadGbpPerformanceRecords,
	loadGbpSearchKeywordRecords,
} from './gbp-performance-records.server.ts'

async function seedOrgWithTwoLocations() {
	const [org] = await db
		.insert(Organization)
		.values({
			name: 'GBP Perf Org',
			slug: `gbp-perf-${crypto.randomUUID().slice(0, 8)}`,
			dataRegion: 'us',
		})
		.returning()
	const [locA, locB] = await db
		.insert(OrganizationLocation)
		.values([
			{
				organizationId: org!.id,
				name: 'Downtown',
				slug: 'downtown',
				timezone: 'America/New_York',
				isActive: true,
				isDefault: true,
			},
			{
				organizationId: org!.id,
				name: 'Uptown',
				slug: 'uptown',
				timezone: 'America/New_York',
				isActive: true,
				isDefault: false,
			},
		])
		.returning()
	return { org: org!, locA: locA!, locB: locB! }
}

describe('GBP report record loaders (#136)', () => {
	it('pivots daily metrics, honors LocationScope, and computes dataUntil', async () => {
		const { org, locA, locB } = await seedOrgWithTwoLocations()
		await db.insert(GbpLocationSync).values([
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				googleLocationName: `locations/${locA.id}`,
				fieldsSynced: '[]',
				verificationState: 'verified',
			},
			{
				organizationId: org.id,
				organizationLocationId: locB.id,
				googleLocationName: `locations/${locB.id}`,
				fieldsSynced: '[]',
				verificationState: 'verified',
			},
		])
		await db.insert(GbpDailyMetric).values([
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				date: '2026-04-10',
				metric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
				value: 100,
			},
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				date: '2026-04-10',
				metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
				value: 50,
			},
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				date: '2026-04-10',
				metric: 'CALL_CLICKS',
				value: 12,
			},
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				date: '2026-04-10',
				metric: 'BUSINESS_FOOD_ORDERS',
				value: 9,
			},
			{
				organizationId: org.id,
				organizationLocationId: locB.id,
				date: '2026-04-11',
				metric: 'WEBSITE_CLICKS',
				value: 33,
			},
		])

		const all = await loadGbpPerformanceRecords(org.id, null)
		expect(all.dataUntil).toBe('2026-04-11')
		expect(all.emptyNotice).toBeNull()
		expect(all.records).toHaveLength(2)

		const scopedA = await loadGbpPerformanceRecords(org.id, [locA.id])
		expect(scopedA.dataUntil).toBe('2026-04-10')
		expect(scopedA.records).toHaveLength(1)
		expect(scopedA.records[0]).toMatchObject({
			location: 'Downtown',
			views: 150,
			searchViews: 100,
			mapsViews: 50,
			calls: 12,
			foodOrders: 9,
		})

		const scopedNone = await loadGbpPerformanceRecords(org.id, [])
		expect(scopedNone.records).toEqual([])
	})

	it('returns the unverified notice when no verified location has metrics', async () => {
		const { org, locA } = await seedOrgWithTwoLocations()
		await db.insert(GbpLocationSync).values({
			organizationId: org.id,
			organizationLocationId: locA.id,
			googleLocationName: `locations/${locA.id}`,
			fieldsSynced: '[]',
			verificationState: 'unverified',
		})

		const loaded = await loadGbpPerformanceRecords(org.id, [locA.id])
		expect(loaded.records).toEqual([])
		expect(loaded.hasVerifiedLocation).toBe(false)
		expect(loaded.emptyNotice).toBe('No data until your profile is verified')
	})

	it('preserves Google < 15 threshold verbatim on search keywords and enforces scope', async () => {
		const { org, locA, locB } = await seedOrgWithTwoLocations()
		await db.insert(GbpSearchKeyword).values([
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				month: '2026-03',
				keyword: 'shawarma near me',
				value: 240,
				threshold: null,
			},
			{
				organizationId: org.id,
				organizationLocationId: locA.id,
				month: '2026-03',
				keyword: 'late night wraps',
				value: null,
				threshold: 15,
			},
			{
				organizationId: org.id,
				organizationLocationId: locB.id,
				month: '2026-03',
				keyword: 'uptown falafel',
				value: 45,
				threshold: null,
			},
		])

		const scoped = await loadGbpSearchKeywordRecords(org.id, [locA.id])
		expect(scoped.records).toHaveLength(2)
		const exact = scoped.records.find((r) => r.keyword === 'shawarma near me')
		const thresholded = scoped.records.find(
			(r) => r.keyword === 'late night wraps',
		)
		expect(exact).toMatchObject({
			impressions: 240,
			impressionsDisplay: '240',
		})
		expect(thresholded).toMatchObject({
			impressions: null,
			impressionsDisplay: '< 15',
		})
	})
})
