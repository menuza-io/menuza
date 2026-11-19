import { figureOfMetric } from '@repo/common/gbp-metrics'
import {
	and,
	db,
	eq,
	GbpLocationSync,
	inArray,
	OrganizationLocation,
} from '@repo/database'
import { type ReportRecord } from '@repo/reports'
import {
	loadDailyMetricRows,
	loadKeywordRows,
	type LocationScope,
} from '#app/utils/gbp/metrics.server.ts'

export type LoadedGbpPerformanceRecords = {
	records: ReportRecord[]
	dataUntil: string | null
	hasVerifiedLocation: boolean
	emptyNotice: string | null
}

async function locationNameMap(
	organizationId: string,
	scope: LocationScope,
): Promise<Map<string, string>> {
	if (scope !== null && scope.length === 0) return new Map()
	const conditions = [eq(OrganizationLocation.organizationId, organizationId)]
	if (scope !== null) {
		conditions.push(inArray(OrganizationLocation.id, [...scope].slice(0, 90)))
	}
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
		})
		.from(OrganizationLocation)
		.where(and(...conditions))
	return new Map(rows.map((row) => [row.id, row.name]))
}

/**
 * Pivots daily `GbpDailyMetric` rows into one report record per (location, day),
 * honoring the viewer's location scope and surfacing `dataUntil` and the
 * unverified empty notice (#136).
 */
export async function loadGbpPerformanceRecords(
	organizationId: string,
	scope: LocationScope,
): Promise<LoadedGbpPerformanceRecords> {
	const [rows, names, syncs] = await Promise.all([
		loadDailyMetricRows(organizationId, scope),
		locationNameMap(organizationId, scope),
		db
			.select({
				locationId: GbpLocationSync.organizationLocationId,
				verificationState: GbpLocationSync.verificationState,
			})
			.from(GbpLocationSync)
			.where(eq(GbpLocationSync.organizationId, organizationId)),
	])

	const scopedSyncs = syncs.filter(
		(s) => scope === null || scope.includes(s.locationId),
	)
	const hasVerifiedLocation = scopedSyncs.some(
		(s) => s.verificationState === 'verified',
	)

	const byKey = new Map<
		string,
		{
			day: string
			locationId: string
			location: string
			views: number
			searchViews: number
			mapsViews: number
			calls: number
			websiteClicks: number
			directionRequests: number
			foodOrders: number
			bookings: number
		}
	>()

	let dataUntil: string | null = null

	for (const row of rows) {
		if (!dataUntil || row.date > dataUntil) {
			dataUntil = row.date
		}
		const key = `${row.locationId}:${row.date}`
		let entry = byKey.get(key)
		if (!entry) {
			entry = {
				day: `${row.date}T00:00:00.000Z`,
				locationId: row.locationId,
				location: names.get(row.locationId) ?? row.locationId,
				views: 0,
				searchViews: 0,
				mapsViews: 0,
				calls: 0,
				websiteClicks: 0,
				directionRequests: 0,
				foodOrders: 0,
				bookings: 0,
			}
			byKey.set(key, entry)
		}
		const figure = figureOfMetric(row.metric)
		switch (figure) {
			case 'searchViews':
				entry.searchViews += row.value
				entry.views += row.value
				break
			case 'mapsViews':
				entry.mapsViews += row.value
				entry.views += row.value
				break
			case 'calls':
				entry.calls += row.value
				break
			case 'websiteClicks':
				entry.websiteClicks += row.value
				break
			case 'directions':
				entry.directionRequests += row.value
				break
			case 'orderClicks':
				entry.foodOrders += row.value
				break
			case 'bookingClicks':
				entry.bookings += row.value
				break
			default:
				break
		}
	}

	const records: ReportRecord[] = [...byKey.values()].sort((a, b) =>
		b.day.localeCompare(a.day),
	)

	const emptyNotice =
		records.length === 0 && !hasVerifiedLocation
			? 'No data until your profile is verified'
			: null

	return { records, dataUntil, hasVerifiedLocation, emptyNotice }
}

/**
 * Loads monthly Google search terms for the viewer's location scope, preserving
 * Google's `< 15` threshold range verbatim (#136).
 */
export async function loadGbpSearchKeywordRecords(
	organizationId: string,
	scope: LocationScope,
): Promise<{ records: ReportRecord[] }> {
	const [rows, names] = await Promise.all([
		loadKeywordRows(organizationId, scope),
		locationNameMap(organizationId, scope),
	])

	const records: ReportRecord[] = rows.map((row) => ({
		month: row.month,
		locationId: row.locationId,
		location: names.get(row.locationId) ?? row.locationId,
		keyword: row.keyword,
		impressions: row.value ?? null,
		impressionsDisplay:
			row.value !== null && row.value !== undefined
				? String(row.value)
				: row.threshold
					? `< ${row.threshold}`
					: '< 15',
	}))

	return { records }
}
