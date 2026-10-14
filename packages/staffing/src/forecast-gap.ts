import {
	type ForecastDay,
	type ForecastGapView,
	type ForecastPositionTotal,
	type ForecastSlot,
	type ForecastSlotStatus,
} from './labor-api.ts'
import { DEMAND_TRAILING_WEEKS, type DemandGuide } from './schedule-api.ts'
import { localDateOf } from './schedule-time.ts'
import { localParts } from './tz.ts'

/**
 * The orders-based forecast against the schedule. Deterministic, and the same
 * method as the demand guide: the expected orders of an hour are the median
 * counted online orders of that weekday and hour over the trailing weeks, and
 * never fewer than the orders already booked for it. The manager sets how many
 * orders one person in a position handles per hour (the standard); an hour
 * needs `ceil(expected orders / standard)` people in that position. Scheduled
 * people are counted by the real time of their shifts inside each local hour.
 *
 * The method is ours: it is a planning aid, never a promise of sales. It sees
 * online orders only, and says so.
 */

/** A person short by at least this much of an hour makes the hour "short". */
export const GAP_SHORT_THRESHOLD = 0.5
/** A position over its need by at least this much (and nothing short) is "over". */
export const GAP_OVER_THRESHOLD = 1

const SLOT_MINUTES = 15
const SLOT_MS = SLOT_MINUTES * 60_000

export type ForecastShiftFact = {
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	unpaidBreakMinutes: number
}

export type BookedOrderFact = { date: string; hour: number; orders: number }

function oneDecimal(value: number): number {
	return Math.round(value * 10) / 10
}

/** Staff needed for `orders` in an hour at `standard` orders per person-hour. */
export function neededPeople(orders: number, standard: number): number {
	if (!(orders > 0) || !(standard > 0)) return 0
	// Floating division can land a hair above an exact quotient (3.6 / 1.2).
	return Math.ceil(Math.round((orders / standard) * 1e6) / 1e6)
}

export function slotStatus(input: {
	orders: number
	needed: number
	scheduled: number
	short: number
	surplus: number
}): ForecastSlotStatus {
	if (input.short >= GAP_SHORT_THRESHOLD) return 'short'
	if (input.surplus >= GAP_OVER_THRESHOLD) return 'over'
	if (input.orders <= 0 && input.scheduled <= 0) return 'quiet'
	return 'ok'
}

type HourKey = string

const hourKey = (date: string, hour: number): HourKey => `${date}#${hour}`

/**
 * Scheduled person-hours by local date, hour and position, from live assigned
 * shifts. A shift contributes its unpaid-break-adjusted real time to each hour
 * it overlaps (the walk is in real 15-minute steps, so a daylight-saving day
 * holds the right number of hours). Open shifts are not people yet and are not
 * counted.
 */
export function scheduledByHour(
	shiftsToCount: readonly ForecastShiftFact[],
	timeZone: string,
	dates: ReadonlySet<string>,
): {
	byHour: Map<string, Map<string, number>>
	unpositioned: Map<string, number>
} {
	const byHour = new Map<string, Map<string, number>>()
	const unpositioned = new Map<string, number>()
	for (const shift of shiftsToCount) {
		if (shift.staffId === null) continue
		const duration = (shift.endsAt - shift.startsAt) / 60_000
		if (!(duration > 0)) continue
		const paidFactor =
			Math.max(0, duration - Math.max(0, shift.unpaidBreakMinutes)) / duration
		// Steps follow the clock's 15-minute grid so a shift that starts at 10:07
		// puts its first minutes in the 10:00 hour and the rest where they fall.
		for (let t = shift.startsAt, end = 0; t < shift.endsAt; t = end) {
			end = Math.min((Math.floor(t / SLOT_MS) + 1) * SLOT_MS, shift.endsAt)
			const fractionOfHour = ((end - t) / 3_600_000) * paidFactor
			const date = localDateOf(t, timeZone)
			if (!dates.has(date)) continue
			const hour = localParts(t, timeZone).hour
			if (shift.positionId === null) {
				unpositioned.set(date, (unpositioned.get(date) ?? 0) + fractionOfHour)
				continue
			}
			const key = hourKey(date, hour)
			const positions = byHour.get(key) ?? new Map<string, number>()
			positions.set(
				shift.positionId,
				(positions.get(shift.positionId) ?? 0) + fractionOfHour,
			)
			byHour.set(key, positions)
		}
	}
	return { byHour, unpositioned }
}

export function computeForecastGap(input: {
	guide: DemandGuide
	/** Orders already booked for a future hour (scheduled-for, paid or active). */
	booked: readonly BookedOrderFact[]
	/** Orders per labor hour by position id: only positions with a standard count. */
	standards: Readonly<Record<string, number>>
	shifts: readonly ForecastShiftFact[]
	timeZone: string
	weeks?: number
}): ForecastGapView {
	const positionIds = Object.keys(input.standards).sort()
	const configured = positionIds.length > 0
	const dates = new Set(input.guide.days.map((day) => day.date))
	const bookedByHour = new Map<string, number>()
	for (const fact of input.booked) {
		const key = hourKey(fact.date, fact.hour)
		bookedByHour.set(key, (bookedByHour.get(key) ?? 0) + fact.orders)
	}
	const { byHour, unpositioned } = scheduledByHour(
		input.shifts,
		input.timeZone,
		dates,
	)

	const days: ForecastDay[] = input.guide.days.map((guideDay) => {
		const totals = new Map<string, { needed: number; scheduled: number }>(
			positionIds.map((id) => [id, { needed: 0, scheduled: 0 }]),
		)
		let neededHours = 0
		let scheduledHours = 0
		let shortHours = 0
		let surplusHours = 0
		const hours: ForecastSlot[] = Array.from({ length: 24 }, (_, hour) => {
			const key = hourKey(guideDay.date, hour)
			const median = guideDay.hours[hour] ?? 0
			const booked = bookedByHour.get(key) ?? 0
			const orders = oneDecimal(Math.max(median, booked))
			const scheduledHere = byHour.get(key)
			let needed = 0
			let scheduled = 0
			let short = 0
			let surplus = 0
			for (const id of positionIds) {
				const need = neededPeople(orders, input.standards[id]!)
				const have = scheduledHere?.get(id) ?? 0
				needed += need
				scheduled += have
				short += Math.max(0, need - have)
				surplus += Math.max(0, have - need)
				const total = totals.get(id)!
				total.needed += need
				total.scheduled += have
			}
			neededHours += needed
			scheduledHours += scheduled
			shortHours += short
			surplusHours += surplus
			const slot = {
				orders,
				needed,
				scheduled: oneDecimal(scheduled),
				short: oneDecimal(short),
				surplus: oneDecimal(surplus),
			}
			return {
				hour,
				orders,
				booked,
				needed,
				scheduled: slot.scheduled,
				short: slot.short,
				surplus: slot.surplus,
				// Judged on the unrounded figures; the shown ones are for reading.
				status: configured
					? slotStatus({ orders, needed, scheduled, short, surplus })
					: 'quiet',
			}
		})
		const byPosition: ForecastPositionTotal[] = positionIds.map((id) => ({
			positionId: id,
			ordersPerLaborHour: input.standards[id]!,
			neededHours: oneDecimal(totals.get(id)!.needed),
			scheduledHours: oneDecimal(totals.get(id)!.scheduled),
		}))
		return {
			date: guideDay.date,
			hours,
			neededHours: oneDecimal(neededHours),
			scheduledHours: oneDecimal(scheduledHours),
			shortHours: oneDecimal(shortHours),
			surplusHours: oneDecimal(surplusHours),
			unpositionedHours: oneDecimal(unpositioned.get(guideDay.date) ?? 0),
			byPosition,
		}
	})

	return {
		kind: 'forecast_gap',
		estimate: true,
		method: 'median_orders_per_labor_hour',
		source: 'online_orders',
		weeks: input.weeks ?? DEMAND_TRAILING_WEEKS,
		windowStart: input.guide.windowStart,
		windowEnd: input.guide.windowEnd,
		timeZone: input.timeZone,
		configured,
		days,
	}
}
