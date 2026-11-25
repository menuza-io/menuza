import { getLocationCurrency } from '@repo/common/location-currency'
import { planMissedWindows, plannedMinutes } from '@repo/common/missed-sales'
import { onlineOpenWindows } from '@repo/common/ordering-hours'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import {
	formatDate,
	isValidTimeZone,
	localParts,
	startOfLocalDay,
} from '@repo/zoned-time'
import { type MissedPlanEntry } from './missed-estimate.ts'
import { loadPauseHistory } from './ordering-pause-history.server.ts'

const DAY_MS = 86_400_000
/** Four weeks of history and a week of margin before the first pause. */
const LOOKBACK_MS = 6 * 7 * DAY_MS

function parseJson(value: string | null): unknown {
	if (!value) return undefined
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

/**
 * The windows to estimate for the pauses of an organization's locations
 * (#176), from the one pause history and the scheduled online hours.
 *
 * - `latest`: each location's current pause, else its last one that began
 *   within `withinDays` (the Orders page's pause card).
 * - `today`: every pause that was on at any time since each location's own
 *   midnight (the Today line, whose "today" is the location's day).
 *
 * `locationIds` limits it to the member's locations (`null`: all). A pause
 * entirely outside the open hours has nothing to estimate and is left out.
 * Busy mode is not in the history, so it can never appear here.
 */
export async function loadMissedPlanEntries(
	organizationId: string,
	options: {
		now: Date
		mode: { kind: 'latest'; withinDays: number } | { kind: 'today' }
		locationIds: readonly string[] | null
	},
): Promise<MissedPlanEntry[]> {
	const { now } = options
	// The earliest a pause of interest can have begun (a day's margin for "today").
	const earliestAny =
		options.mode.kind === 'today'
			? now.getTime() - 2 * DAY_MS
			: now.getTime() - options.mode.withinDays * DAY_MS
	const from = earliestAny - LOOKBACK_MS
	const [locations, history] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
				address: OrganizationLocation.address,
				isActive: OrganizationLocation.isActive,
				storeHours: OrganizationLocation.storeHours,
				onlineHours: OrganizationLocation.onlineHours,
				specialHours: OrganizationLocation.specialHours,
			})
			.from(OrganizationLocation)
			.where(and(eq(OrganizationLocation.organizationId, organizationId)))
			.limit(500),
		loadPauseHistory(organizationId, {
			from: new Date(from),
			to: now,
		}),
	])
	const allowed = options.locationIds === null ? null : new Set(options.locationIds)
	const entries: MissedPlanEntry[] = []
	for (const location of locations) {
		if (allowed && !allowed.has(location.id)) continue
		const mine = history.filter((row) => row.locationId === location.id)
		const asWindow = (row: (typeof mine)[number]) => ({
			from: row.startedAt.getTime(),
			to: row.endedAt ? row.endedAt.getTime() : now.getTime(),
		})
		const pauses = mine.filter((row) => row.kind === 'pause')
		const off = mine.map(asWindow)
		const timeZone = isValidTimeZone(location.timezone ?? '')
			? location.timezone!
			: 'UTC'
		let todayStart = 0
		if (options.mode.kind === 'today') {
			const parts = localParts(now.getTime(), timeZone)
			todayStart = startOfLocalDay(
				formatDate(parts.year, parts.month, parts.day),
				timeZone,
			)
		}
		const chosen =
			options.mode.kind === 'latest'
				? pauses
						.filter((row) => row.startedAt.getTime() >= earliestAny)
						.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
						.slice(0, 1)
				: pauses.filter((row) => asWindow(row).to > todayStart)
		const openWindows = onlineOpenWindows(
			{
				timeZone,
				isActive: location.isActive,
				storeHours: parseJson(location.storeHours),
				onlineHours: parseJson(location.onlineHours),
				specialHours: parseJson(location.specialHours),
			},
			{ from, to: now.getTime() },
		)
		for (const row of chosen) {
			const window = asWindow(row)
			const plans = planMissedWindows({
				pause: window,
				openWindows,
				otherOffWindows: off,
				timeZone,
				now: now.getTime(),
			})
			if (plans.length === 0) continue
			entries.push({
				id: `${location.id}:${row.startedAt.getTime()}`,
				locationId: location.id,
				locationName: location.name,
				currency: getLocationCurrency(location.address),
				timeZone,
				current: row.endedAt === null,
				startedAt: row.startedAt.getTime(),
				endedAt: row.endedAt ? row.endedAt.getTime() : null,
				minutesPaused: plannedMinutes(plans),
				plans,
			})
		}
	}
	return entries
}
