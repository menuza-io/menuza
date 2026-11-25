import {
	computeUptime,
	computeUptimeByDay,
	type UptimeBreakdown,
	type UptimeDay,
} from '@repo/common/ordering-uptime'
import {
	intersectWindows,
	mergeWindows,
	type TimeWindow,
} from '@repo/common/ordering-windows'
import { getOrderingHistory } from '../lib/ordering-history.ts'
import { getMenuRoster } from '../lib/menu-roster.ts'
import { type TenantDatabase } from '@repo/tenant-db'
import { loadSoldOutOccurrences } from './sold-out-report-records.ts'

/**
 * Online ordering uptime per location (#405): of the scheduled online hours,
 * how much online ordering was open, split into paused by staff, dishes
 * unavailable and closed unexpectedly. The pause history, hours and closures
 * are the control plane's (windows only, from `getOrderingHistory`); sold-out
 * history is the region's. It never adds a second pause store.
 *
 * "Dishes unavailable" means every dish the location could take an order for
 * was off at once (stock sold-out or switched off by hand), so nothing could
 * be ordered. One dish being out does not make the location down.
 */

export type LocationUptime = UptimeBreakdown & {
	locationId: string
	name: string
	timeZone: string
	currency: string
	days: UptimeDay[]
}

export type OnlineUptime = {
	period: { from: number; to: number }
	locations: LocationUptime[]
	/** All the locations together (minutes added, not percentages averaged). */
	overall: UptimeBreakdown
	/** The menu could not be read, so a location where every dish was out is not told apart. */
	dishesKnown: boolean
}

function sum(locations: readonly LocationUptime[]): UptimeBreakdown {
	const total = {
		scheduledMinutes: 0,
		minutes: { open: 0, paused: 0, dishes: 0, closed: 0 },
	}
	for (const location of locations) {
		total.scheduledMinutes += location.scheduledMinutes
		total.minutes.open += location.minutes.open
		total.minutes.paused += location.minutes.paused
		total.minutes.dishes += location.minutes.dishes
		total.minutes.closed += location.minutes.closed
	}
	const round = (value: number) => Math.round(value * 10) / 10
	return {
		scheduledMinutes: round(total.scheduledMinutes),
		minutes: {
			open: round(total.minutes.open),
			paused: round(total.minutes.paused),
			dishes: round(total.minutes.dishes),
			closed: round(total.minutes.closed),
		},
		uptimePercent:
			total.scheduledMinutes > 0
				? round((total.minutes.open / total.scheduledMinutes) * 100)
				: null,
	}
}

/** When every dish in `dishIds` was off at once at one location. */
function allOffWindows(
	dishIds: readonly string[],
	offByDish: ReadonlyMap<string, readonly TimeWindow[]>,
): TimeWindow[] {
	if (dishIds.length === 0) return []
	let common: TimeWindow[] | null = null
	for (const id of dishIds) {
		const windows = offByDish.get(id) ?? []
		if (windows.length === 0) return []
		common = common === null ? mergeWindows(windows) : intersectWindows(common, windows)
		if (common.length === 0) return []
	}
	return common ?? []
}

export async function loadOnlineUptime(
	ctx: {
		db: TenantDatabase
		orgId: string
		locationIds: readonly string[] | null
		now: Date
	},
	range: { from: number; to: number },
	asked: readonly string[] | null,
): Promise<OnlineUptime | null> {
	const to = Math.min(range.to, ctx.now.getTime())
	if (to <= range.from) {
		return {
			period: { from: range.from, to: range.from },
			locations: [],
			overall: sum([]),
			dishesKnown: true,
		}
	}
	const history = await getOrderingHistory(ctx.orgId, { from: range.from, to })
	if (!history) return null
	const roster = await getMenuRoster(ctx.orgId)
	const allowed = ctx.locationIds === null ? null : new Set(ctx.locationIds)
	const wanted = asked === null ? null : new Set(asked)
	const scope = history.locations.filter(
		(location) =>
			(allowed === null || allowed.has(location.id)) &&
			(wanted === null || wanted.has(location.id)),
	)

	const occurrences =
		scope.length === 0
			? []
			: await loadSoldOutOccurrences(
					{
						db: ctx.db,
						orgId: ctx.orgId,
						locationIds: scope.map((location) => location.id),
						now: ctx.now,
					},
					{ startMs: range.from, endMs: to },
					{ overlapping: true },
				)
	const offByLocation = new Map<string, Map<string, TimeWindow[]>>()
	for (const occurrence of occurrences) {
		if (occurrence.entityType !== 'item') continue
		const byDish = offByLocation.get(occurrence.locationId) ?? new Map()
		const list = byDish.get(occurrence.entityId) ?? []
		list.push({
			from: occurrence.startedAt.getTime(),
			to: occurrence.endedAt ? occurrence.endedAt.getTime() : to,
		})
		byDish.set(occurrence.entityId, list)
		offByLocation.set(occurrence.locationId, byDish)
	}

	const locations: LocationUptime[] = scope.map((location) => {
		const orderable = (roster?.dishes ?? [])
			.filter(
				(dish) =>
					dish.availabilityStatus === 'available' &&
					!dish.hiddenLocationIds.includes(location.id),
			)
			.map((dish) => dish.id)
		const input = {
			period: { from: range.from, to },
			openWindows: location.openWindows,
			pauses: location.pauses,
			dishesUnavailable: allOffWindows(
				orderable,
				offByLocation.get(location.id) ?? new Map(),
			),
			closures: location.closures,
			timeZone: location.timezone,
		}
		return {
			locationId: location.id,
			name: location.name,
			timeZone: location.timezone,
			currency: location.currency,
			...computeUptime(input),
			days: computeUptimeByDay(input),
		}
	})
	// Lowest uptime first: the location that needs a look is at the top.
	locations.sort(
		(a, b) =>
			(a.uptimePercent ?? 101) - (b.uptimePercent ?? 101) ||
			a.name.localeCompare(b.name),
	)
	return {
		period: { from: range.from, to },
		locations,
		overall: sum(locations),
		dishesKnown: roster !== null,
	}
}
