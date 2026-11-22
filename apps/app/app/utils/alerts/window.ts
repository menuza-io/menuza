import { addLocalDays } from '@repo/common/location-availability'
import {
	locationLocalClock,
	locationOpenIntervals,
	parseLocationHours,
} from '@repo/opening-hours'

export type AlertHoursRow = {
	timezone: string | null
	isActive?: boolean | null
	storeHours: string | null
	onlineHours?: string | null
	specialHours: string | null
}

/**
 * Whether `nowMs` is within the location's store hours widened by `marginMs` on
 * each side (#131: an hour, #190: half an hour). `unknown` when the location has
 * no usable opening hours: the caller decides whether that alerts (an order that
 * just arrived did, a silent tablet is not called an outage, like #356).
 */
export function alertWindowState(
	row: AlertHoursRow,
	nowMs: number,
	marginMs: number,
): 'inside' | 'outside' | 'unknown' {
	const timeZone = row.timezone || 'UTC'
	const { hours } = parseLocationHours(
		{
			timeZone,
			isActive: row.isActive ?? true,
			storeHours: row.storeHours ?? undefined,
			onlineHours: row.onlineHours ?? undefined,
			specialHours: row.specialHours ?? undefined,
		},
		{ malformedPolicy: 'open' },
	)
	const { date: today } = locationLocalClock(nowMs, timeZone)
	const intervals = locationOpenIntervals(
		hours,
		addLocalDays(today, -1).date,
		addLocalDays(today, 1).date,
	)
	if (intervals === null) return 'unknown'
	return intervals.some(
		(interval) =>
			nowMs >= interval.startMs - marginMs && nowMs < interval.endMs + marginMs,
	)
		? 'inside'
		: 'outside'
}

/**
 * When the location is open from yesterday to tomorrow (store hours, epoch ms),
 * or null when its hours are not set. The region reads this to decide when an
 * order or a tablet may alert, so it needs no hours of its own.
 */
export function openIntervalsAround(
	row: AlertHoursRow,
	nowMs: number,
): Array<{ startMs: number; endMs: number }> | null {
	const timeZone = row.timezone || 'UTC'
	const { hours } = parseLocationHours(
		{
			timeZone,
			isActive: row.isActive ?? true,
			storeHours: row.storeHours ?? undefined,
			onlineHours: row.onlineHours ?? undefined,
			specialHours: row.specialHours ?? undefined,
		},
		{ malformedPolicy: 'open' },
	)
	const { date: today } = locationLocalClock(nowMs, timeZone)
	return locationOpenIntervals(
		hours,
		addLocalDays(today, -1).date,
		addLocalDays(today, 1).date,
	)
}
