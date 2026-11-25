import {
	localParts,
	zonedLocalToUtc,
	isValidTimeZone,
	addDays,
	formatDate,
} from '@repo/zoned-time'
import {
	intersectWindows,
	isCoveredBy,
	mergeWindows,
	overlaps,
	type TimeWindow,
	windowMs,
} from './ordering-windows.ts'

/**
 * The estimate of online sales missed while ordering was paused (#176). Pure.
 *
 * Estimate = the average web and QR sales that count toward sales in the same
 * weekday and time window over the previous weeks at the same location. A week
 * where that window was also paused or closed, or was outside the location's
 * hours, is left out; with fewer than `MISSED_SALES_MIN_WEEKS` usable weeks
 * there is no estimate ("Not enough history yet"). Only the hours the location
 * would have been open count, and busy mode never counts (orders still
 * arrive). Always an estimate: never added to real sales.
 *
 * The open question (4 or 8 weeks) is decided: 4. A month is long enough to
 * average out one odd evening and short enough to follow a season, the
 * same lookback the sold-out estimate uses, and with the two-week minimum it
 * still answers for a location that is only a month old.
 */
export const MISSED_SALES_WEEKS = 4
export const MISSED_SALES_MIN_WEEKS = 2

/** One pause window to estimate, with the earlier weeks it is averaged over. */
export type MissedPlan = {
	/** The window itself (the part of the pause inside open hours). */
	from: number
	to: number
	/** The same window one, two, ... weeks earlier, only the usable ones. */
	weeks: TimeWindow[]
	/** Previous weeks left out (paused, closed or outside the hours). */
	weeksSkipped: number
	/** Local weekday (0 = Sunday) and wall-clock times of the window. */
	weekday: number
	localFrom: string
	localTo: string
}

function pad(value: number) {
	return String(value).padStart(2, '0')
}

function localClock(ms: number, zone: string): string {
	const parts = localParts(ms, zone)
	return `${pad(parts.hour)}:${pad(parts.minute)}`
}

/** `ms` moved back by whole local weeks, keeping its wall-clock time (DST-safe). */
export function shiftWeeksBack(ms: number, weeks: number, zone: string): number {
	const parts = localParts(ms, zone)
	const date = addDays(
		formatDate(parts.year, parts.month, parts.day),
		-7 * weeks,
	)
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return zonedLocalToUtc(year, month, day, parts.hour, parts.minute, zone)
}

export type PlanInput = {
	/** The pause's own window (an open pause ends at `now`). */
	pause: TimeWindow
	/** Scheduled online open hours as windows; null: no hours configured (always open). */
	openWindows: readonly TimeWindow[] | null
	/** Every earlier pause and closure of the location (the pause itself may be in it). */
	otherOffWindows: readonly TimeWindow[]
	timeZone: string
	now: number
	weeks?: number
}

/**
 * The windows to estimate for one pause: the pause cut to the open hours, one
 * plan per continuous piece (a pause that runs past closing and into the next
 * day is two). Weeks that cannot be compared are dropped and counted.
 */
export function planMissedWindows(input: PlanInput): MissedPlan[] {
	const zone = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC'
	const horizon = input.weeks ?? MISSED_SALES_WEEKS
	const end = Math.min(input.pause.to, input.now)
	if (end <= input.pause.from) return []
	const open = input.openWindows
	const pieces =
		open === null
			? [{ from: input.pause.from, to: end }]
			: intersectWindows([{ from: input.pause.from, to: end }], open)
	const off = mergeWindows(input.otherOffWindows)
	return pieces.map((piece) => {
		const weeks: TimeWindow[] = []
		let skipped = 0
		for (let week = 1; week <= horizon; week += 1) {
			const earlier = {
				from: shiftWeeksBack(piece.from, week, zone),
				to: shiftWeeksBack(piece.to, week, zone),
			}
			// Left out: paused or closed then, or outside the hours then.
			const usable =
				earlier.to > earlier.from &&
				!overlaps(earlier, off) &&
				(open === null || isCoveredBy(earlier, open))
			if (usable) weeks.push(earlier)
			else skipped += 1
		}
		const start = localParts(piece.from, zone)
		return {
			from: piece.from,
			to: piece.to,
			weeks,
			weeksSkipped: skipped,
			weekday: new Date(
				Date.UTC(start.year, start.month - 1, start.day),
			).getUTCDay(),
			localFrom: localClock(piece.from, zone),
			localTo: localClock(piece.to, zone),
		}
	})
}

export type WeekTotals = { orders: number; salesMinor: number }

export type MissedEstimate =
	| {
			enough: true
			/** Average orders in the window over the usable weeks, rounded. */
			orders: number
			/** Average sales in minor units, rounded. */
			salesMinor: number
			weeksUsed: number
	  }
	| { enough: false; weeksUsed: number }

/**
 * The estimate from the totals of each usable earlier week. Fewer than
 * `MISSED_SALES_MIN_WEEKS` weeks is "not enough history", with no figure.
 */
export function averageMissed(weeks: readonly WeekTotals[]): MissedEstimate {
	if (weeks.length < MISSED_SALES_MIN_WEEKS) {
		return { enough: false, weeksUsed: weeks.length }
	}
	const orders = weeks.reduce((sum, week) => sum + week.orders, 0) / weeks.length
	const salesMinor =
		weeks.reduce((sum, week) => sum + week.salesMinor, 0) / weeks.length
	return {
		enough: true,
		orders: Math.round(orders),
		salesMinor: Math.round(salesMinor),
		weeksUsed: weeks.length,
	}
}

/** Minutes of a plan or window, for "Paused 1 h 40 min". */
export function plannedMinutes(plans: readonly MissedPlan[]): number {
	return Math.round(
		windowMs(plans.map((plan) => ({ from: plan.from, to: plan.to }))) / 60_000,
	)
}
