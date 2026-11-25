import { describe, expect, it } from 'vitest'
import {
	averageMissed,
	MISSED_SALES_MIN_WEEKS,
	MISSED_SALES_WEEKS,
	plannedMinutes,
	planMissedWindows,
	shiftWeeksBack,
} from './missed-sales.ts'
import { zonedLocalToUtc } from '@repo/zoned-time'

const ZONE = 'America/Chicago'
const HOUR = 3_600_000
const at = (day: number, hour: number, minute = 0, month = 11) =>
	zonedLocalToUtc(2026, month, day, hour, minute, ZONE)

/** Open 11:00 to 22:00 local on every day of the five weeks before `from`. */
function openEveryDay(firstDay: number, lastDay: number, month = 11) {
	const windows: Array<{ from: number; to: number }> = []
	for (let day = firstDay; day <= lastDay; day += 1) {
		windows.push({ from: at(day, 11, 0, month), to: at(day, 22, 0, month) })
	}
	return windows
}

describe('planMissedWindows (#176)', () => {
	// Friday 2026-11-20, a 2 hour pause from 18:00 to 20:00.
	const pause = { from: at(20, 18), to: at(20, 20) }
	const now = at(21, 9)
	// Opening hours every day from 2026-10-16 to 2026-11-21.
	const open = [
		...openEveryDay(16, 31, 10),
		...openEveryDay(1, 21, 11),
	]

	it('averages the same weekday and window over the previous four weeks', () => {
		const [plan] = planMissedWindows({
			pause,
			openWindows: open,
			otherOffWindows: [pause],
			timeZone: ZONE,
			now,
		})
		expect(MISSED_SALES_WEEKS).toBe(4)
		expect(plan).toMatchObject({
			from: pause.from,
			to: pause.to,
			weeksSkipped: 0,
			localFrom: '18:00',
			localTo: '20:00',
			weekday: 5,
		})
		expect(plan!.weeks).toHaveLength(4)
		// The Fridays 13 Nov, 6 Nov, 30 Oct and 23 Oct at the same wall clock.
		expect(plan!.weeks[0]).toEqual({ from: at(13, 18), to: at(13, 20) })
		expect(plan!.weeks[3]).toEqual({ from: at(23, 18, 0, 10), to: at(23, 20, 0, 10) })
		expect(plannedMinutes([plan!])).toBe(120)
	})

	it('leaves a week out when that window was also paused or closed', () => {
		const [plan] = planMissedWindows({
			pause,
			openWindows: open,
			otherOffWindows: [
				pause,
				{ from: at(13, 17), to: at(13, 19) }, // paused the Friday before
				{ from: at(30, 19, 0, 10), to: at(30, 21, 0, 10) }, // closed 3 weeks back
			],
			timeZone: ZONE,
			now,
		})
		expect(plan!.weeks).toHaveLength(2)
		expect(plan!.weeksSkipped).toBe(2)
		expect(averageMissed([{ orders: 10, salesMinor: 3000 }, { orders: 14, salesMinor: 5000 }])).toMatchObject({
			enough: true,
			orders: 12,
			salesMinor: 4000,
			weeksUsed: 2,
		})
	})

	it('leaves a week out when the location was not open for the whole window then', () => {
		const withoutFriday = open.filter(
			(window) => window.from !== at(6, 11),
		)
		const [plan] = planMissedWindows({
			pause,
			openWindows: withoutFriday,
			otherOffWindows: [pause],
			timeZone: ZONE,
			now,
		})
		expect(plan!.weeks).toHaveLength(3)
		expect(plan!.weeksSkipped).toBe(1)
	})

	it('counts only the hours the location would have been open when a pause runs past closing', () => {
		const late = { from: at(20, 21), to: at(21, 1) } // 21:00 to 01:00
		const plans = planMissedWindows({
			pause: late,
			openWindows: open,
			otherOffWindows: [late],
			timeZone: ZONE,
			now: at(21, 9),
		})
		expect(plans).toHaveLength(1)
		expect(plans[0]).toMatchObject({ from: at(20, 21), to: at(20, 22) })
		expect(plannedMinutes(plans)).toBe(60)
	})

	it('treats an open pause as ending now and a pause entirely outside the hours as nothing', () => {
		const openPause = { from: at(21, 12), to: Number.MAX_SAFE_INTEGER }
		const plans = planMissedWindows({
			pause: openPause,
			openWindows: open,
			otherOffWindows: [openPause],
			timeZone: ZONE,
			now: at(21, 14),
		})
		expect(plans[0]).toMatchObject({ from: at(21, 12), to: at(21, 14) })
		const night = { from: at(20, 23), to: at(21, 6) }
		expect(
			planMissedWindows({
				pause: night,
				openWindows: open,
				otherOffWindows: [night],
				timeZone: ZONE,
				now,
			}),
		).toEqual([])
	})

	it('shows no estimate with fewer than two usable weeks', () => {
		expect(MISSED_SALES_MIN_WEEKS).toBe(2)
		expect(averageMissed([{ orders: 12, salesMinor: 4000 }])).toEqual({
			enough: false,
			weeksUsed: 1,
		})
		expect(averageMissed([])).toEqual({ enough: false, weeksUsed: 0 })
	})

	it('keeps the wall clock across a daylight saving change', () => {
		// Daylight time ends in Chicago on Sunday 2026-11-01: a week earlier is
		// still 18:00 local although the offset differs by an hour.
		const sunday = at(1, 18)
		const back = shiftWeeksBack(sunday, 1, ZONE)
		expect(back).toBe(at(25, 18, 0, 10))
		expect(sunday - back).toBe(7 * 24 * HOUR + HOUR)
	})

	it('with no hours configured everything is open', () => {
		const [plan] = planMissedWindows({
			pause,
			openWindows: null,
			otherOffWindows: [pause],
			timeZone: ZONE,
			now,
		})
		expect(plan!.weeks).toHaveLength(4)
	})
})
