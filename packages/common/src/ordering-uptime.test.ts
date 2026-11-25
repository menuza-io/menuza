import { describe, expect, it } from 'vitest'
import { computeUptime, computeUptimeByDay } from './ordering-uptime.ts'
import { zonedLocalToUtc } from '@repo/zoned-time'

const ZONE = 'Asia/Riyadh'
const at = (day: number, hour: number, minute = 0) =>
	zonedLocalToUtc(2026, 11, day, hour, minute, ZONE)

// A 10-hour day: open 12:00 to 22:00.
const day = (d: number) => ({ from: at(d, 12), to: at(d, 22) })
const period = { from: at(10, 0), to: at(11, 0) }

describe('computeUptime (#405)', () => {
	it('shows 90% with the reason when a location was paused for an hour of a 10 hour day', () => {
		const result = computeUptime({
			period,
			openWindows: [day(10)],
			pauses: [{ from: at(10, 18), to: at(10, 19) }],
			dishesUnavailable: [],
			closures: [],
			timeZone: ZONE,
		})
		expect(result.scheduledMinutes).toBe(600)
		expect(result.uptimePercent).toBe(90)
		expect(result.minutes).toEqual({ open: 540, paused: 60, dishes: 0, closed: 0 })
	})

	it('does not count overnight closed hours as downtime', () => {
		// A pause from 20:00 to 23:30 only costs the two open hours before closing.
		const paused = computeUptime({
			period,
			openWindows: [day(10)],
			pauses: [{ from: at(10, 20), to: at(10, 23, 30) }],
			dishesUnavailable: [],
			closures: [],
			timeZone: ZONE,
		})
		expect(paused.minutes.paused).toBe(120)
		expect(paused.uptimePercent).toBe(80)
		// Nothing wrong all day: the closed night is not 14 hours of downtime.
		const quiet = computeUptime({
			period,
			openWindows: [day(10)],
			pauses: [],
			dishesUnavailable: [],
			closures: [],
			timeZone: ZONE,
		})
		expect(quiet.uptimePercent).toBe(100)
		expect(quiet.scheduledMinutes).toBe(600)
	})

	it('counts a moment once, as paused before dishes before closed', () => {
		const result = computeUptime({
			period,
			openWindows: [day(10)],
			pauses: [{ from: at(10, 12), to: at(10, 14) }],
			dishesUnavailable: [{ from: at(10, 13), to: at(10, 16) }],
			closures: [{ from: at(10, 15), to: at(10, 18) }],
			timeZone: ZONE,
		})
		expect(result.minutes).toEqual({
			open: 600 - 120 - 120 - 120,
			paused: 120,
			dishes: 120, // 14:00 to 16:00 (13:00 to 14:00 was already a pause)
			closed: 120, // 16:00 to 18:00
		})
		expect(result.uptimePercent).toBe(40)
	})

	it('counts scheduled time a closure took away even when the new hours no longer include it', () => {
		const result = computeUptime({
			period,
			openWindows: [{ from: at(10, 12), to: at(10, 18) }],
			pauses: [],
			dishesUnavailable: [],
			// Hours were cut from 22:00 to 18:00 at short notice.
			closures: [{ from: at(10, 18), to: at(10, 22) }],
			timeZone: ZONE,
		})
		expect(result.scheduledMinutes).toBe(600)
		expect(result.minutes.closed).toBe(240)
		expect(result.uptimePercent).toBe(60)
	})

	it('treats a location with no hours configured as open all day and reports no figure with nothing scheduled', () => {
		expect(
			computeUptime({
				period,
				openWindows: null,
				pauses: [{ from: at(10, 0), to: at(10, 6) }],
				dishesUnavailable: [],
				closures: [],
				timeZone: ZONE,
			}).uptimePercent,
		).toBe(75)
		expect(
			computeUptime({
				period,
				openWindows: [],
				pauses: [],
				dishesUnavailable: [],
				closures: [],
				timeZone: ZONE,
			}).uptimePercent,
		).toBeNull()
	})

	it('splits the same figures by local day', () => {
		const days = computeUptimeByDay({
			period: { from: at(10, 0), to: at(12, 0) },
			openWindows: [day(10), day(11)],
			pauses: [{ from: at(11, 12), to: at(11, 17) }],
			dishesUnavailable: [],
			closures: [],
			timeZone: ZONE,
		})
		expect(days.map((d) => [d.date, d.uptimePercent])).toEqual([
			['2026-11-10', 100],
			['2026-11-11', 50],
		])
	})
})
