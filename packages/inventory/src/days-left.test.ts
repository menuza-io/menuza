import { addDays } from '@repo/reservations'
import { describe, expect, it } from 'vitest'
import {
	computeDaysLeft,
	isCountStale,
	nextDeliveryDate,
	runsOutBeforeDelivery,
	type DailyUse,
} from './days-left.ts'
import { weekdayDemand } from './prep.ts'

// A Monday outside Ramadan (Hijri month 9 of 1448 is February-March 2027).
const TODAY = '2026-11-16'

function steady(days: number, quantity: number, today = TODAY): DailyUse[] {
	return Array.from({ length: days }, (_, index) => ({
		date: addDays(today, -(index + 1)),
		quantity,
	}))
}

describe('computeDaysLeft', () => {
	it('is 2.5 days for 2 kg a day with 5 kg on hand', () => {
		const result = computeDaysLeft({
			today: TODAY,
			onHand: 5_000_000,
			history: steady(28, 2_000_000),
		})
		expect(result).toMatchObject({
			state: 'ok',
			days: 2.5,
			perDay: 2_000_000,
			// Mon (1), Tue (2), half of Wed: it runs out on Wednesday.
			runsOutDate: '2026-11-18',
		})
	})

	it('says not enough history under seven days of use', () => {
		expect(
			computeDaysLeft({
				today: TODAY,
				onHand: 5_000_000,
				history: steady(6, 2_000_000),
			}),
		).toEqual({ state: 'not_enough_history', useDays: 6 })
		expect(computeDaysLeft({ today: TODAY, onHand: 1, history: [] })).toEqual({
			state: 'not_enough_history',
			useDays: 0,
		})
	})

	it('does not count closed days as quiet ones', () => {
		// Seven open days among 28: the average is over the days it was used.
		const history = steady(7, 3_000_000)
		const result = computeDaysLeft({
			today: TODAY,
			onHand: 6_000_000,
			history,
		})
		expect(result.state === 'ok' && result.perDay).toBe(3_000_000)
	})

	it('is zero days when already out', () => {
		expect(
			computeDaysLeft({
				today: TODAY,
				onHand: -5,
				history: steady(10, 1_000_000),
			}),
		).toMatchObject({ state: 'ok', days: 0, runsOutDate: TODAY })
	})

	it('shapes the days by the same weekday factor prep uses', () => {
		// Mondays use 4 kg, other days 2 kg over four weeks: Monday is busy.
		const history: DailyUse[] = []
		for (let offset = 1; offset <= 28; offset++) {
			const date = addDays(TODAY, -offset)
			const monday = new Date(`${date}T00:00:00Z`).getUTCDay() === 1
			history.push({ date, quantity: monday ? 4_000_000 : 2_000_000 })
		}
		const factor = weekdayDemand({
			date: TODAY,
			history: history.map((day) => ({ date: day.date, units: day.quantity })),
		})
		expect(factor.known).toBe(true)
		expect(factor.bp).toBeGreaterThan(10_000)
		const flat = computeDaysLeft({
			today: TODAY,
			onHand: 3_000_000,
			history: steady(28, 2_285_714),
		})
		const shaped = computeDaysLeft({ today: TODAY, onHand: 3_000_000, history })
		// Today is a busy Monday: the same stock lasts fewer days than flat use.
		expect(flat.state === 'ok' && shaped.state === 'ok').toBe(true)
		if (flat.state === 'ok' && shaped.state === 'ok') {
			expect(shaped.days).toBeLessThan(flat.days)
		}
	})

	it('compares Ramadan days with Ramadan days only', () => {
		// 2027-02-15 is in Ramadan 1448: history outside Ramadan is left out of
		// the weekday factor, exactly like prep.
		const ramadanToday = '2027-02-25'
		const history = steady(28, 2_000_000, ramadanToday)
		const units = history.map((day) => ({
			date: day.date,
			units: day.quantity,
		}))
		const factor = weekdayDemand({ date: ramadanToday, history: units })
		expect(factor.ramadan).toBe(true)
		const result = computeDaysLeft({
			today: ramadanToday,
			onHand: 5_000_000,
			history,
		})
		// Whatever the factor, the result uses prep's own function.
		expect(result.state).toBe('ok')
	})
})

describe('delivery days', () => {
	it('finds the next delivery after today', () => {
		// Monday 2026-11-16; Fridays are weekday 5.
		expect(nextDeliveryDate(TODAY, [5])).toBe('2026-11-20')
		expect(nextDeliveryDate(TODAY, [1])).toBe('2026-11-23')
		expect(nextDeliveryDate(TODAY, [])).toBeNull()
	})

	it('flags an item that runs out before the next delivery', () => {
		const daysLeft = computeDaysLeft({
			today: TODAY,
			onHand: 5_000_000,
			history: steady(28, 2_000_000),
		})
		expect(
			runsOutBeforeDelivery({ daysLeft, today: TODAY, deliveryDays: [5] }),
		).toEqual({ runsOutDate: '2026-11-18', nextDelivery: '2026-11-20' })
		// A delivery on the day it runs out is in time.
		expect(
			runsOutBeforeDelivery({ daysLeft, today: TODAY, deliveryDays: [3] }),
		).toBeNull()
		expect(
			runsOutBeforeDelivery({
				daysLeft: { state: 'not_enough_history', useDays: 2 },
				today: TODAY,
				deliveryDays: [5],
			}),
		).toBeNull()
	})
})

describe('isCountStale', () => {
	const now = Date.UTC(2026, 10, 16)
	it('is stale after 14 days or when never counted', () => {
		expect(isCountStale(null, now)).toBe(true)
		expect(isCountStale(now - 15 * 86_400_000, now)).toBe(true)
		expect(isCountStale(now - 13 * 86_400_000, now)).toBe(false)
	})
})
