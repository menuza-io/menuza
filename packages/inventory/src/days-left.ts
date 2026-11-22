import { addDays, dayOfWeek } from '@repo/reservations'
import {
	MIN_HISTORY_DAYS,
	NEUTRAL_DEMAND_BP,
	PREP_HISTORY_DAYS,
	weekdayDemand,
} from './prep.ts'

/**
 * Days of stock left (#492), pure and explainable: what is on hand divided by
 * how much the item is used in a day. The use rate is the average over the
 * days it was used in the last 28 (closed days do not count as quiet ones),
 * shaped forward by the same weekday factor prep uses (`weekdayDemand`, Ramadan
 * days compared with Ramadan days), so a Friday that sells 20% more empties
 * the shelf a little sooner. Fewer than seven days of use is "not enough
 * history": a guess from two days would read as a fact. No I/O here.
 */

export const DAYS_LEFT_HISTORY_DAYS = PREP_HISTORY_DAYS
/** An item not counted for this long shows its number greyed. */
export const STALE_COUNT_DAYS = 14
const STALE_COUNT_MS = STALE_COUNT_DAYS * 24 * 60 * 60 * 1000
/** Past two months the figure stops meaning anything. */
export const MAX_DAYS_LEFT = 60

/** Use of one item at one location on a business date (base thousandths, positive). */
export type DailyUse = { date: string; quantity: number }

export type DaysLeft =
	| {
			state: 'ok'
			/** Whole and fractional days (0 when already out). */
			days: number
			/** Average use on a day it is used, base thousandths. */
			perDay: number
			/** The business date stock is used up, `null` past `MAX_DAYS_LEFT`. */
			runsOutDate: string | null
			/** Days of use the rate rests on. */
			useDays: number
	  }
	| { state: 'not_enough_history'; useDays: number }

/** What `days` means for the person: `5 / 2 = 2.5`. */
export function computeDaysLeft(input: {
	/** Business date of today at the location. */
	today: string
	onHand: number
	/** Use per day for the last 28 days (any order; dates before `today`). */
	history: readonly DailyUse[]
}): DaysLeft {
	const from = addDays(input.today, -DAYS_LEFT_HISTORY_DAYS)
	const days = input.history.filter(
		(day) => day.date >= from && day.date < input.today && day.quantity > 0,
	)
	if (days.length < MIN_HISTORY_DAYS) {
		return { state: 'not_enough_history', useDays: days.length }
	}
	const perDay = days.reduce((sum, day) => sum + day.quantity, 0) / days.length
	const units = days.map((day) => ({ date: day.date, units: day.quantity }))
	if (input.onHand <= 0) {
		return {
			state: 'ok',
			days: 0,
			perDay: Math.round(perDay),
			runsOutDate: input.today,
			useDays: days.length,
		}
	}
	let remaining = input.onHand
	for (let offset = 0; offset < MAX_DAYS_LEFT; offset++) {
		const date = addDays(input.today, offset)
		const factor = weekdayDemand({ date, history: units })
		const expected = (perDay * factor.bp) / NEUTRAL_DEMAND_BP
		if (expected <= 0) continue
		if (remaining <= expected) {
			const total = offset + remaining / expected
			return {
				state: 'ok',
				days: total,
				perDay: Math.round(perDay),
				runsOutDate: addDays(input.today, Math.floor(total)),
				useDays: days.length,
			}
		}
		remaining -= expected
	}
	return {
		state: 'ok',
		days: MAX_DAYS_LEFT,
		perDay: Math.round(perDay),
		runsOutDate: null,
		useDays: days.length,
	}
}

/** Not counted in 14 days (or never): the number is shown greyed. */
export function isCountStale(
	lastCountedAt: number | null,
	now: number,
): boolean {
	return lastCountedAt === null || now - lastCountedAt > STALE_COUNT_MS
}

/** The first delivery day after `today` (a weekday in `deliveryDays`), or null. */
export function nextDeliveryDate(
	today: string,
	deliveryDays: readonly number[],
): string | null {
	if (deliveryDays.length === 0) return null
	for (let offset = 1; offset <= 7; offset++) {
		const date = addDays(today, offset)
		if (deliveryDays.includes(dayOfWeek(date))) return date
	}
	return null
}

/**
 * Whether the item is used up before the supplier's next delivery day
 * ("Runs out Thursday, next delivery Friday"). A delivery on the very day
 * stock runs out is in time.
 */
export function runsOutBeforeDelivery(input: {
	daysLeft: DaysLeft
	today: string
	deliveryDays: readonly number[]
}): { runsOutDate: string; nextDelivery: string } | null {
	if (input.daysLeft.state !== 'ok' || !input.daysLeft.runsOutDate) return null
	const next = nextDeliveryDate(input.today, input.deliveryDays)
	if (!next) return null
	return input.daysLeft.runsOutDate < next
		? { runsOutDate: input.daysLeft.runsOutDate, nextDelivery: next }
		: null
}
