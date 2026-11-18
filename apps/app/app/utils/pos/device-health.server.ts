import { getFeatureFlag } from '@repo/common/feature-flags'
import { addLocalDays } from '@repo/common/location-availability'
import {
	locationLocalClock,
	locationOpenIntervals,
	parseLocationHours,
} from '@repo/opening-hours'
import { zonedLocalToUtc } from '@repo/zoned-time'

/**
 * Station connection history (#356): an organization flag, default off, only a
 * literal `true` counts. Read by the Terminals page (App) and by the regional
 * tenant-api (`/resources/pos/flags`).
 */
export const POS_DEVICE_HEALTH_FLAG = 'pos.device_health'

export async function isDeviceHealthOn(organizationId: string) {
	return (
		(await getFeatureFlag(POS_DEVICE_HEALTH_FLAG, { organizationId })) === true
	)
}

export type HealthWindow = {
	timeZone: string
	/** The last seven local days, today last. */
	days: Array<{ date: string; startMs: number; endMs: number }>
	/**
	 * When the location was open over those days. Null means its opening hours
	 * are not set (or not usable): no outage is inferred then.
	 */
	open: Array<{ startMs: number; endMs: number }> | null
}

type HoursRow = {
	timezone: string | null
	isActive: boolean
	storeHours: string | null
	onlineHours: string | null
	specialHours: string | null
}

/**
 * The seven local days the Health panel draws and the location's opening hours
 * over them (store hours, not online ordering hours). A terminal with no
 * location has no hours: its days are in UTC and nothing is inferred.
 */
export function buildHealthWindow(
	row: HoursRow | null,
	nowMs: number,
): HealthWindow {
	const timeZone = row?.timezone || 'UTC'
	const { date: today } = locationLocalClock(nowMs, timeZone)
	const dates = Array.from(
		{ length: 7 },
		(_, i) => addLocalDays(today, i - 6).date,
	)
	const startOf = (date: string) => {
		const [y = 1970, m = 1, d = 1] = date.split('-').map(Number)
		return zonedLocalToUtc(y, m, d, 0, 0, timeZone)
	}
	const days = dates.map((date) => ({
		date,
		startMs: startOf(date),
		endMs: startOf(addLocalDays(date, 1).date),
	}))
	let open: HealthWindow['open'] = null
	if (row) {
		const { hours } = parseLocationHours(
			{
				timeZone,
				isActive: row.isActive,
				storeHours: row.storeHours ?? undefined,
				onlineHours: row.onlineHours ?? undefined,
				specialHours: row.specialHours ?? undefined,
			},
			{ malformedPolicy: 'open' },
		)
		open = locationOpenIntervals(hours, dates[0]!, today)
	}
	return { timeZone, days, open }
}
