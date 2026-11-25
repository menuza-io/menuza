import { describe, expect, it } from 'vitest'
import { zonedLocalToUtc } from '@repo/zoned-time'
import { onlineOpenWindows, planHoursClosures } from './ordering-hours.ts'

const ZONE = 'Asia/Riyadh'
const at = (day: number, hour: number, minute = 0) =>
	zonedLocalToUtc(2026, 11, day, hour, minute, ZONE)

const DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
]
const week = (start: string, end: string) =>
	DAYS.map((day) => ({ day, isOpen: true, slots: [{ start, end }] }))

describe('online open windows', () => {
	it('lists the scheduled hours of each day inside the range', () => {
		const windows = onlineOpenWindows(
			{ timeZone: ZONE, storeHours: week('12:00', '21:59') },
			{ from: at(10, 0), to: at(12, 0) },
		)
		expect(windows).toEqual([
			{ from: at(10, 12), to: at(10, 22) },
			{ from: at(11, 12), to: at(11, 22) },
		])
	})

	it('returns null when no hours are configured and nothing for an inactive location', () => {
		expect(
			onlineOpenWindows({ timeZone: ZONE }, { from: at(10, 0), to: at(11, 0) }),
		).toBeNull()
		expect(
			onlineOpenWindows(
				{ timeZone: ZONE, storeHours: week('12:00', '21:59'), isActive: false },
				{ from: at(10, 0), to: at(11, 0) },
			),
		).toEqual([])
	})

	it('uses an online override and a special closed day', () => {
		const windows = onlineOpenWindows(
			{
				timeZone: ZONE,
				storeHours: week('09:00', '23:59'),
				onlineHours: week('12:00', '21:59'),
				specialHours: [{ id: 's1', date: '2026-11-11', isOpen: false, slots: [] }],
			},
			{ from: at(10, 0), to: at(12, 0) },
		)
		expect(windows).toEqual([{ from: at(10, 12), to: at(10, 22) }])
	})
})

describe('hours edits that take scheduled time away (#405)', () => {
	const now = at(10, 15)
	it('records what the old hours had open and the new ones do not', () => {
		// Closing cut from 22:00 to 18:00 at 15:00 the same day.
		const closures = planHoursClosures({
			before: { timeZone: ZONE, storeHours: week('12:00', '21:59') },
			after: { timeZone: ZONE, storeHours: week('12:00', '17:59') },
			now,
		})
		expect(closures[0]).toEqual({ from: at(10, 18), to: at(10, 22) })
		// The next day is also within 36 hours and also loses its evening.
		expect(closures[1]).toEqual({ from: at(11, 18), to: at(11, 22) })
	})

	it('records nothing when the hours only grow, nothing was scheduled, or nothing changed', () => {
		const same = { timeZone: ZONE, storeHours: week('12:00', '21:59') }
		expect(planHoursClosures({ before: same, after: same, now })).toEqual([])
		expect(
			planHoursClosures({
				before: same,
				after: { timeZone: ZONE, storeHours: week('10:00', '23:59') },
				now,
			}),
		).toEqual([])
		expect(
			planHoursClosures({ before: { timeZone: ZONE }, after: same, now }),
		).toEqual([])
	})

	it('records the hours of a location that was deactivated', () => {
		const closures = planHoursClosures({
			before: { timeZone: ZONE, storeHours: week('12:00', '21:59') },
			after: { timeZone: ZONE, storeHours: week('12:00', '21:59'), isActive: false },
			now,
		})
		expect(closures[0]).toEqual({ from: now, to: at(10, 22) })
	})
})
