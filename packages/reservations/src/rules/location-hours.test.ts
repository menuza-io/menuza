import { describe, expect, it } from 'vitest'
import {
	buildEffectiveDay,
	instantInIntervals,
	isLocationOpenAt,
	locationOpenIntervals,
	parseLocationHours,
	parseSpecialHours,
	parseWeeklyHours,
	weeklyOpenAtMinute,
	type LocationHours,
	type LocationWeeklyDay,
} from './location-hours.ts'
import { localToInstant } from '../time.ts'
import { reservationsContextSchema } from '../schemas/internal.ts'

const DAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

function week(
	over: Partial<Record<(typeof DAYS)[number], [string, string][] | null>> = {},
	fallback: [string, string][] = [['11:00', '22:00']],
): LocationWeeklyDay[] {
	return DAYS.map((day) => {
		const slots = day in over ? over[day] : fallback
		return {
			day,
			isOpen: slots !== null && slots !== undefined,
			slots: (slots ?? []).map(([start, end]) => ({ start, end })),
		}
	})
}

function hours(over: Partial<LocationHours> = {}): LocationHours {
	return {
		timeZone: 'America/New_York',
		isActive: true,
		storeHours: week(),
		specialHours: null,
		...over,
	}
}

const at = (date: string, min: number, tz = 'America/New_York') =>
	localToInstant(date, min, tz).instantMs

// 2026-06-12 is a Friday, 2026-06-13 a Saturday.
describe('isLocationOpenAt', () => {
	it('follows the weekly pattern and treats the end as inclusive', () => {
		const h = hours()
		expect(isLocationOpenAt(h, at('2026-06-12', 10 * 60 + 59)).open).toBe(false)
		expect(isLocationOpenAt(h, at('2026-06-12', 11 * 60)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-12', 22 * 60)).open).toBe(true)
		const after = isLocationOpenAt(h, at('2026-06-12', 22 * 60 + 1))
		expect(after).toMatchObject({ open: false, reason: 'outside_hours' })
	})

	it('reports a closed weekday', () => {
		const h = hours({ storeHours: week({ monday: null }) })
		expect(isLocationOpenAt(h, at('2026-06-15', 12 * 60))).toMatchObject({
			open: false,
			reason: 'closed_weekday',
		})
	})

	it('supports several ranges per day (split shifts)', () => {
		const h = hours({
			storeHours: week({
				friday: [
					['11:00', '14:00'],
					['17:00', '22:00'],
				],
			}),
		})
		expect(isLocationOpenAt(h, at('2026-06-12', 12 * 60)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-12', 15 * 60)).open).toBe(false)
		expect(isLocationOpenAt(h, at('2026-06-12', 18 * 60)).open).toBe(true)
	})

	it('lets a special entry replace the weekly pattern for that date', () => {
		const h = hours({
			specialHours: [
				{
					id: 's1',
					date: '2026-06-12',
					isOpen: true,
					slots: [{ start: '10:00', end: '16:00' }],
				},
				{
					id: 's2',
					date: '2026-06-13',
					isOpen: false,
					slots: [],
					note: 'Private event',
				},
			],
		})
		expect(isLocationOpenAt(h, at('2026-06-12', 12 * 60)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-12', 18 * 60)).open).toBe(false)
		expect(isLocationOpenAt(h, at('2026-06-13', 18 * 60))).toMatchObject({
			open: false,
			reason: 'special_closed',
			note: 'Private event',
		})
	})

	it('is closed when the location is inactive', () => {
		expect(
			isLocationOpenAt(hours({ isActive: false }), at('2026-06-12', 12 * 60)),
		).toMatchObject({ open: false, reason: 'inactive' })
	})

	it('fails open without any schedule', () => {
		expect(
			isLocationOpenAt(hours({ storeHours: null }), at('2026-06-12', 3 * 60))
				.open,
		).toBe(true)
	})

	it('handles midnight-split overnight hours and a closed special day cutting the tail', () => {
		const h = hours({
			storeHours: week({
				friday: [['18:00', '23:59']],
				saturday: [
					['00:00', '02:00'],
					['18:00', '23:59'],
				],
			}),
		})
		expect(isLocationOpenAt(h, at('2026-06-12', 23 * 60 + 59)).open).toBe(true)
		// 00:30 on Saturday is a real local clock time covered by Saturday's 00:00-02:00 slice.
		expect(isLocationOpenAt(h, at('2026-06-13', 30)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-13', 3 * 60)).open).toBe(false)
		const closedSat = hours({
			...h,
			specialHours: [{ id: 's', date: '2026-06-13', isOpen: false, slots: [] }],
		})
		expect(isLocationOpenAt(closedSat, at('2026-06-13', 30)).open).toBe(false)
	})

	it('treats an end before the start as an overnight range', () => {
		const h = hours({ storeHours: week({ friday: [['22:00', '02:00']] }) })
		expect(isLocationOpenAt(h, at('2026-06-12', 23 * 60)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-13', 60)).open).toBe(true)
		expect(isLocationOpenAt(h, at('2026-06-13', 2 * 60 + 1)).open).toBe(false)
	})

	it('converts the instant into the location time zone, not the reservation one', () => {
		const h = hours({
			timeZone: 'Asia/Riyadh',
			storeHours: week({}, [['12:00', '23:00']]),
		})
		// 12:00 in Riyadh is 09:00 UTC.
		expect(isLocationOpenAt(h, Date.UTC(2026, 5, 12, 8, 59)).open).toBe(false)
		expect(isLocationOpenAt(h, Date.UTC(2026, 5, 12, 9, 0)).open).toBe(true)
		expect(isLocationOpenAt(h, Date.UTC(2026, 5, 12, 20, 0)).open).toBe(true)
		expect(isLocationOpenAt(h, Date.UTC(2026, 5, 12, 20, 1)).open).toBe(false)
	})

	it('uses the real local clock around the spring-forward gap (America/New_York)', () => {
		// 2026-03-08: 02:00 -> 03:00. Open 01:00-04:00 on Sunday.
		const h = hours({ storeHours: week({ sunday: [['01:00', '04:00']] }) })
		expect(isLocationOpenAt(h, Date.UTC(2026, 2, 8, 6, 30)).open).toBe(true) // 01:30 EST
		expect(isLocationOpenAt(h, Date.UTC(2026, 2, 8, 7, 30)).open).toBe(true) // 03:30 EDT
		expect(isLocationOpenAt(h, Date.UTC(2026, 2, 8, 8, 30)).open).toBe(false) // 04:30 EDT
	})
})

describe('locationOpenIntervals', () => {
	it('returns null when nothing is configured and [] when inactive', () => {
		expect(
			locationOpenIntervals(
				hours({ storeHours: null }),
				'2026-06-12',
				'2026-06-13',
			),
		).toBeNull()
		expect(
			locationOpenIntervals(
				hours({ isActive: false }),
				'2026-06-12',
				'2026-06-13',
			),
		).toEqual([])
	})

	it('merges the 23:59 / 00:00 midnight split into one interval', () => {
		const h = hours({
			storeHours: week({
				friday: [['18:00', '23:59']],
				saturday: [['00:00', '02:00']],
			}),
		})
		const ivs = locationOpenIntervals(h, '2026-06-12', '2026-06-13')!
		expect(ivs).toHaveLength(1)
		expect(ivs[0]!.startMs).toBe(at('2026-06-12', 18 * 60))
		// 02:00 inclusive end covers the whole 02:00 minute.
		expect(ivs[0]!.endMs).toBe(at('2026-06-13', 2 * 60 + 1))
		expect(instantInIntervals(ivs, at('2026-06-13', 90))).toBe(true)
		expect(instantInIntervals(ivs, at('2026-06-13', 3 * 60))).toBe(false)
	})

	it('measures a DST-length day in real instants', () => {
		const h = hours({ storeHours: week({ sunday: [['00:00', '23:59']] }) })
		const [iv] = locationOpenIntervals(h, '2026-03-08', '2026-03-08')!
		expect(iv!.endMs - iv!.startMs).toBe(23 * 3_600_000)
	})
})

describe('buildEffectiveDay', () => {
	const noReservation = { closed: false, onlineClosed: false }

	it('closes the day from location special hours and ignores a reservation special day', () => {
		const h = hours({
			specialHours: [
				{
					id: 's',
					date: '2026-12-25',
					isOpen: false,
					slots: [],
					note: 'Christmas',
				},
			],
		})
		const day = buildEffectiveDay({
			businessDate: '2026-12-25',
			hours: h,
			dayStartMin: 240,
			reservation: {
				closed: false,
				onlineClosed: false,
				specialDay: { type: 'replace', name: 'Gala' },
			},
		})
		expect(day).toMatchObject({
			open: false,
			source: 'location_closed',
			closedReason: 'special_closed',
			note: 'Christmas',
		})
	})

	it('reports an inactive location and a closed weekday', () => {
		expect(
			buildEffectiveDay({
				businessDate: '2026-06-12',
				hours: hours({ isActive: false }),
				dayStartMin: 240,
				reservation: noReservation,
			}),
		).toMatchObject({ open: false, closedReason: 'inactive' })
		expect(
			buildEffectiveDay({
				businessDate: '2026-06-15',
				hours: hours({ storeHours: week({ monday: null }) }),
				dayStartMin: 240,
				reservation: noReservation,
			}),
		).toMatchObject({
			open: false,
			source: 'location_closed',
			closedReason: 'closed_weekday',
		})
	})

	it('keeps a reservations-only closure on an open location', () => {
		expect(
			buildEffectiveDay({
				businessDate: '2026-06-12',
				hours: hours(),
				dayStartMin: 240,
				reservation: {
					closed: true,
					onlineClosed: true,
					specialDay: { type: 'closed', name: 'Buyout', note: 'Private' },
				},
			}),
		).toMatchObject({
			open: false,
			source: 'reservation_special_day',
			closedReason: 'special_day',
			name: 'Buyout',
		})
	})

	it('keeps online_closed open for staff and labels modified days', () => {
		expect(
			buildEffectiveDay({
				businessDate: '2026-06-12',
				hours: hours(),
				dayStartMin: 240,
				reservation: {
					closed: false,
					onlineClosed: true,
					specialDay: { type: 'online_closed', name: 'Walk-ins' },
				},
			}),
		).toMatchObject({
			open: true,
			onlineClosed: true,
			source: 'reservation_special_day',
		})
	})

	it('labels the source location_hours when hours exist and weekly when unknown', () => {
		const base = {
			businessDate: '2026-06-12',
			dayStartMin: 240,
			reservation: noReservation,
		}
		expect(buildEffectiveDay({ ...base, hours: hours() }).source).toBe(
			'location_hours',
		)
		expect(buildEffectiveDay({ ...base, hours: null }).source).toBe('weekly')
		expect(
			buildEffectiveDay({ ...base, hours: hours({ storeHours: null }) }).source,
		).toBe('weekly')
	})

	it('keeps the Friday business day open when only Saturday is closed (overnight tail)', () => {
		const h = hours({
			storeHours: week({ friday: [['18:00', '23:59']] }),
			specialHours: [{ id: 's', date: '2026-06-13', isOpen: false, slots: [] }],
		})
		const friday = buildEffectiveDay({
			businessDate: '2026-06-12',
			hours: h,
			dayStartMin: 240,
			reservation: noReservation,
		})
		expect(friday.open).toBe(true)
		const saturday = buildEffectiveDay({
			businessDate: '2026-06-13',
			hours: h,
			dayStartMin: 240,
			reservation: noReservation,
		})
		expect(saturday.open).toBe(false)
	})

	it('checks a 01:00 slot by its real local time while it belongs to the previous business date', () => {
		const h = hours({
			storeHours: week({
				friday: [['18:00', '23:59']],
				saturday: [['00:00', '02:00']],
			}),
		})
		const day = buildEffectiveDay({
			businessDate: '2026-06-12',
			hours: h,
			dayStartMin: 240,
			reservation: noReservation,
		})
		expect(instantInIntervals(day.intervals, at('2026-06-13', 60))).toBe(true)
		expect(instantInIntervals(day.intervals, at('2026-06-13', 150))).toBe(false)
	})
})

describe('tolerant parsing', () => {
	it('parses typed arrays and raw JSON strings', () => {
		const weekly = week()
		expect(parseWeeklyHours(weekly).value).toHaveLength(7)
		expect(parseWeeklyHours(JSON.stringify(weekly)).value).toHaveLength(7)
		expect(
			parseSpecialHours(
				JSON.stringify([
					{ id: 'a', date: '2026-12-25', isOpen: false, slots: [], note: 'x' },
				]),
			).value,
		).toEqual([
			{ id: 'a', date: '2026-12-25', isOpen: false, slots: [], note: 'x' },
		])
	})

	it('fails open on malformed values and counts them', () => {
		expect(parseWeeklyHours('{nope')).toEqual({ value: null, malformed: true })
		expect(
			parseWeeklyHours([{ day: 'funday', isOpen: true, slots: [] }]),
		).toEqual({
			value: null,
			malformed: true,
		})
		expect(
			parseWeeklyHours([
				{ day: 'monday', isOpen: true, slots: [{ start: '9', end: '17:00' }] },
			]).malformed,
		).toBe(true)
		expect(parseSpecialHours([{ date: 'x', isOpen: true }]).malformed).toBe(
			true,
		)
		expect(parseWeeklyHours(null)).toEqual({ value: null, malformed: false })
		expect(parseWeeklyHours([])).toEqual({ value: null, malformed: false })
		const parsed = parseLocationHours({
			timeZone: 'UTC',
			storeHours: 'garbage',
			specialHours: 42,
		})
		expect(parsed.malformedCount).toBe(2)
		expect(parsed.hours.storeHours).toBeNull()
	})

	it('never rejects the whole context for one bad location value', () => {
		const location = {
			id: 'loc_1',
			name: 'Main',
			slug: 'main',
			timeZone: 'UTC',
			currency: 'USD',
			phone: null,
			address: null,
			storeHours: [{ day: 'nope' }],
			specialHours: JSON.stringify([
				{ id: 'a', date: '2026-12-25', isOpen: false, slots: [] },
			]),
			isActive: true,
		}
		const parsed =
			reservationsContextSchema.shape.locations.element.parse(location)
		expect(parsed.storeHours).toBeNull()
		expect(parsed.specialHours).toHaveLength(1)
	})
})

describe('weeklyOpenAtMinute', () => {
	it('checks service seating minutes against the weekly pattern incl. past midnight', () => {
		const h = hours({
			storeHours: week({
				friday: [['18:00', '23:59']],
				saturday: [['00:00', '02:00']],
			}),
		})
		expect(weeklyOpenAtMinute(h, 5, 19 * 60)).toBe(true)
		expect(weeklyOpenAtMinute(h, 5, 17 * 60)).toBe(false)
		expect(weeklyOpenAtMinute(h, 5, 1440 + 60)).toBe(true) // 01:00 Saturday
		expect(weeklyOpenAtMinute(h, 5, 1440 + 180)).toBe(false)
	})
})
