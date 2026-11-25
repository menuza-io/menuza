import { localParts, addDays, formatDate, zonedLocalToUtc, isValidTimeZone } from '@repo/zoned-time'
import {
	intersectWindows,
	mergeWindows,
	subtractWindows,
	type TimeWindow,
	windowMs,
} from './ordering-windows.ts'

/**
 * Online ordering uptime (#405): of the scheduled open hours, how much was
 * online ordering actually open, and what stopped it. Pure.
 *
 * Only scheduled open hours count. Overnight closed hours are not downtime and
 * a pause that runs into them counts only for the open part. A closure the
 * location took at short notice (an hours edit that removed scheduled time) is
 * scheduled time that was lost, so it is in the denominator and is downtime.
 *
 * Downtime is split by reason, each moment counted once, in this order:
 *   1. `paused`: staff paused online ordering.
 *   2. `dishes`: every dish the location could take an order for was unavailable.
 *   3. `closed`: scheduled hours taken away unexpectedly.
 */

export const UPTIME_REASONS = ['paused', 'dishes', 'closed'] as const
export type UptimeReason = (typeof UPTIME_REASONS)[number]

export type UptimeInput = {
	/** The report window. */
	period: TimeWindow
	/** Scheduled online open hours; null: no hours configured (open all the time). */
	openWindows: readonly TimeWindow[] | null
	/** Staff pause windows (open pauses end at the period's end). */
	pauses: readonly TimeWindow[]
	/** Windows when no dish could be ordered. */
	dishesUnavailable: readonly TimeWindow[]
	/** Scheduled time lost to closures taken at short notice. */
	closures: readonly TimeWindow[]
	timeZone: string
}

export type UptimeBreakdown = {
	/** Minutes of scheduled open time (plus lost closures) in the period. */
	scheduledMinutes: number
	minutes: { open: number } & Record<UptimeReason, number>
	/** 0 to 100, one decimal; null when nothing was scheduled. */
	uptimePercent: number | null
}

function minutesOf(windows: readonly TimeWindow[]) {
	return windowMs(windows) / 60_000
}

function round1(value: number) {
	return Math.round(value * 10) / 10
}

export function computeUptime(input: UptimeInput): UptimeBreakdown {
	const period = [input.period]
	const open =
		input.openWindows === null
			? period
			: intersectWindows(input.openWindows, period)
	const closures = intersectWindows(input.closures, period)
	// Scheduled time: the open hours and the hours a closure took away.
	const scheduled = mergeWindows([...open, ...closures])
	const paused = intersectWindows(input.pauses, scheduled)
	const dishes = subtractWindows(
		intersectWindows(input.dishesUnavailable, scheduled),
		paused,
	)
	const closed = subtractWindows(subtractWindows(closures, paused), dishes)
	const scheduledMinutes = minutesOf(scheduled)
	const down = {
		paused: minutesOf(paused),
		dishes: minutesOf(dishes),
		closed: minutesOf(closed),
	}
	const downTotal = down.paused + down.dishes + down.closed
	return {
		scheduledMinutes: round1(scheduledMinutes),
		minutes: {
			open: round1(Math.max(0, scheduledMinutes - downTotal)),
			paused: round1(down.paused),
			dishes: round1(down.dishes),
			closed: round1(down.closed),
		},
		uptimePercent:
			scheduledMinutes > 0
				? round1(((scheduledMinutes - downTotal) / scheduledMinutes) * 100)
				: null,
	}
}

export type UptimeDay = UptimeBreakdown & { date: string }

/** The same figures per local day (`YYYY-MM-DD`) of the location's time zone. */
export function computeUptimeByDay(input: UptimeInput): UptimeDay[] {
	const zone = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC'
	const first = localParts(input.period.from, zone)
	const last = localParts(input.period.to, zone)
	let date = formatDate(first.year, first.month, first.day)
	const lastDate = formatDate(last.year, last.month, last.day)
	const days: UptimeDay[] = []
	let guard = 0
	while (date <= lastDate && guard++ < 400) {
		const [y, m, d] = date.split('-').map(Number) as [number, number, number]
		const from = Math.max(input.period.from, zonedLocalToUtc(y, m, d, 0, 0, zone))
		const to = Math.min(input.period.to, zonedLocalToUtc(y, m, d + 1, 0, 0, zone))
		if (to > from) {
			days.push({ date, ...computeUptime({ ...input, period: { from, to } }) })
		}
		date = addDays(date, 1)
	}
	return days
}
