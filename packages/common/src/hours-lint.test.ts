import { describe, expect, it } from 'vitest'
import {
	applyHoursFix,
	formatHoursTime,
	hoursFingerprint,
	lintHours,
	type HoursState,
} from './hours-lint.ts'
import {
	DAYS_OF_WEEK,
	DEFAULT_WEEKLY_SCHEDULE,
	type DayOfWeek,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
} from './location-types.ts'

function week(
	slots: TimeSlot[],
	overrides: Partial<Record<DayOfWeek, TimeSlot[] | null>> = {},
): WeeklySchedule {
	return DAYS_OF_WEEK.map((day) => {
		const own = day in overrides ? overrides[day] : slots
		return {
			day,
			isOpen: Boolean(own && own.length > 0),
			slots: own ?? [],
		}
	})
}
const NOW = new Date('2027-06-02T12:00:00Z')
const evening = [{ start: '10:00', end: '22:00' }]

function codes(
	input: Parameters<typeof lintHours>[0],
	options?: Parameters<typeof lintHours>[1],
) {
	return lintHours(input, { now: NOW, ...options }).map((w) => w.code)
}

describe('lintHours: day length and AM/PM mix-ups', () => {
	it('is quiet for the default schedule and ordinary hours', () => {
		expect(
			codes({
				storeHours: DEFAULT_WEEKLY_SCHEDULE,
				onlineHours: DEFAULT_WEEKLY_SCHEDULE,
				specialHours: null,
			}),
		).toEqual([])
		expect(
			codes({ storeHours: week(evening), onlineHours: null, specialHours: [] }),
		).toEqual([])
	})

	it('warns about a 2-hour day and offers the usual hours as the fix', () => {
		const storeHours = week(evening, {
			monday: [{ start: '10:00', end: '12:00' }],
		})
		const warnings = lintHours(
			{ storeHours, onlineHours: null, specialHours: null },
			{ now: NOW },
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({
			code: 'day_too_short',
			scope: 'store',
			day: 'monday',
			params: { hours: 2 },
			fix: { kind: 'set_day_slots', day: 'monday', slots: evening },
		})
	})

	it('warns about a day open over 20 hours', () => {
		const storeHours = week(evening, {
			friday: [{ start: '03:00', end: '23:59' }],
		})
		expect(
			codes({ storeHours, onlineHours: null, specialHours: null }),
		).toEqual(['day_too_long'])
	})

	it('catches a closing time that is before the opening time and suggests the PM time', () => {
		const storeHours = week(evening, {
			tuesday: [{ start: '11:00', end: '10:00' }],
		})
		const [warning] = lintHours(
			{ storeHours, onlineHours: null, specialHours: null },
			{ now: NOW },
		)
		expect(warning).toMatchObject({
			code: 'closes_before_opens',
			day: 'tuesday',
			params: { suggested: '22:00' },
			fix: { kind: 'set_slot_end', day: 'tuesday', slotIndex: 0, end: '22:00' },
		})
		expect(formatHoursTime('22:00')).toBe('10:00 PM')
	})

	it('catches a morning closing when the other days close at night ("Did you mean 11:00 PM?")', () => {
		const storeHours = week(evening, {
			wednesday: [{ start: '10:00', end: '11:00' }],
		})
		const warnings = lintHours(
			{ storeHours, onlineHours: null, specialHours: null },
			{ now: NOW },
		)
		// One warning for the slip; the short day it causes is not warned twice.
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({
			code: 'closing_looks_like_morning',
			params: { suggested: '23:00' },
			fix: { end: '23:00' },
		})
	})

	it('never warns about hours set on purpose: overnight rows and 24-hour days', () => {
		const overnightSplit = week(evening, {
			friday: [{ start: '18:00', end: '23:59' }],
			saturday: [
				{ start: '00:00', end: '02:00' },
				{ start: '12:00', end: '23:59' },
			],
		})
		expect(
			codes({
				storeHours: overnightSplit,
				onlineHours: null,
				specialHours: null,
			}),
		).toEqual([])
		const singleRowOvernight = week(evening, {
			friday: [{ start: '22:00', end: '02:00' }],
		})
		// Open 4 hours on the night, wrapping midnight on purpose.
		expect(
			codes({
				storeHours: singleRowOvernight,
				onlineHours: null,
				specialHours: null,
			}),
		).toEqual([])
		const allDay = week([{ start: '00:00', end: '23:59' }])
		expect(
			codes({ storeHours: allDay, onlineHours: allDay, specialHours: null }),
		).toEqual([])
	})

	it('counts an overnight stretch on the day it starts, so the tail is not a short day', () => {
		const storeHours = week(evening, {
			saturday: [{ start: '18:00', end: '23:59' }],
			sunday: [{ start: '00:00', end: '02:00' }],
		})
		expect(
			codes({ storeHours, onlineHours: null, specialHours: null }),
		).toEqual([])
	})

	it('warns when the location is closed every day', () => {
		const storeHours = week([], {})
		expect(
			codes({ storeHours, onlineHours: null, specialHours: null }),
		).toEqual(['closed_every_day'])
		// No hours at all is the "no hours" check's job, not this one's.
		expect(
			codes({ storeHours: null, onlineHours: null, specialHours: null }),
		).toEqual([])
	})
})

describe('lintHours: online hours against store hours', () => {
	const store = week(evening)

	it('flags online hours outside the store hours, with a fix that matches the store', () => {
		const onlineHours = week(evening, {
			monday: [{ start: '10:00', end: '23:30' }],
		})
		const warnings = lintHours(
			{ storeHours: store, onlineHours, specialHours: null },
			{ now: NOW },
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({
			code: 'online_outside_store',
			scope: 'online',
			day: 'monday',
			params: { from: '22:01', to: '23:31' },
			fix: { kind: 'match_store_day', day: 'monday' },
		})
	})

	it('flags online ordering on a day the store is closed', () => {
		const closedMonday = week(evening, { monday: null })
		const warnings = lintHours(
			{ storeHours: closedMonday, onlineHours: store, specialHours: null },
			{ now: NOW },
		)
		expect(warnings.map((w) => [w.code, w.day])).toEqual([
			['online_outside_store', 'monday'],
		])
	})

	it('flags an online window too short to order in', () => {
		const onlineHours = week(evening, {
			thursday: [{ start: '21:45', end: '22:00' }],
		})
		const warnings = lintHours(
			{ storeHours: store, onlineHours, specialHours: null },
			{ now: NOW },
		)
		expect(warnings.map((w) => w.code)).toEqual(['online_no_time_to_order'])
		expect(warnings[0]?.params.minutes).toBe(16)
	})

	it('flags an online row that wraps midnight, which never opens, and splits it', () => {
		const onlineHours = week(evening, {
			friday: [{ start: '18:00', end: '02:00' }],
		})
		const storeHours = week(evening, {
			friday: [{ start: '18:00', end: '23:59' }],
			saturday: [{ start: '00:00', end: '02:00' }, ...evening],
		})
		const [warning] = lintHours(
			{ storeHours, onlineHours, specialHours: null },
			{ now: NOW },
		).filter((w) => w.code === 'online_overnight_not_split')
		expect(warning?.fix).toMatchObject({
			kind: 'split_overnight',
			day: 'friday',
		})
		const state: HoursState = {
			storeHours,
			onlineHours,
			specialHours: [],
		}
		const fixed = applyHoursFix(warning!.fix!, state)
		expect(
			lintHours({ ...fixed, specialHours: null }, { now: NOW }).filter((w) =>
				w.code.startsWith('online_overnight'),
			),
		).toEqual([])
		expect(
			fixed.onlineHours.find((d) => d.day === 'saturday')?.slots[0],
		).toEqual({
			start: '00:00',
			end: '02:00',
		})
	})

	it('skips the online checks when online hours follow the store hours', () => {
		const onlineHours = week([{ start: '09:00', end: '09:20' }])
		expect(
			codes(
				{ storeHours: store, onlineHours, specialHours: null },
				{ syncOnline: true },
			),
		).toEqual([])
	})

	it('treats an online window as fine when it sits inside an overnight store stretch', () => {
		const storeHours = week(evening, {
			friday: [{ start: '18:00', end: '23:59' }],
			saturday: [{ start: '00:00', end: '02:00' }, ...evening],
		})
		const onlineHours = week(evening, {
			friday: [{ start: '18:00', end: '23:59' }],
			saturday: [{ start: '00:00', end: '01:00' }, ...evening],
		})
		expect(codes({ storeHours, onlineHours, specialHours: null })).toEqual([])
	})
})

describe('lintHours: special hours', () => {
	const entry = (over: Partial<SpecialHour>): SpecialHour => ({
		id: over.id ?? 'e',
		date: '2027-12-25',
		isOpen: false,
		slots: [],
		...over,
	})
	const lint = (specialHours: SpecialHour[]) =>
		lintHours(
			{ storeHours: week(evening), onlineHours: null, specialHours },
			{ now: NOW, timeZone: 'America/New_York' },
		)

	it('finds overlapping slots and merges them with the fix', () => {
		const overlapping = entry({
			isOpen: true,
			slots: [
				{ start: '10:00', end: '14:00' },
				{ start: '13:00', end: '18:00' },
			],
		})
		const [warning] = lint([overlapping])
		expect(warning).toMatchObject({
			code: 'special_overlap',
			date: '2027-12-25',
		})
		const fixed = applyHoursFix(warning!.fix!, {
			storeHours: week(evening),
			onlineHours: week(evening),
			specialHours: [overlapping],
		})
		expect(fixed.specialHours[0]?.slots).toEqual([
			{ start: '10:00', end: '18:00' },
		])
	})

	it('finds an open day with no hours and a closed day that still lists hours', () => {
		expect(
			lint([entry({ id: 'a', isOpen: true, slots: [] })]).map((w) => w.code),
		).toEqual(['special_open_without_hours'])
		expect(
			lint([
				entry({
					id: 'b',
					isOpen: false,
					slots: [{ start: '09:00', end: '17:00' }],
				}),
			]).map((w) => w.code),
		).toEqual(['special_closed_with_hours'])
	})

	it('finds two entries for the same date, but not a one-off override of a repeating entry', () => {
		const duplicates = lint([entry({ id: 'a' }), entry({ id: 'b' })])
		expect(duplicates.map((w) => [w.code, w.specialId])).toEqual([
			['special_duplicate_date', 'b'],
		])
		const override = lint([
			entry({ id: 'yearly', date: '2026-12-25', repeatsYearly: true }),
			entry({ id: 'oneoff', date: '2027-12-25' }),
		])
		expect(override).toEqual([])
	})

	it('ignores past one-off entries and reads today in the location time zone', () => {
		expect(
			lint([entry({ id: 'old', date: '2026-01-01', isOpen: true, slots: [] })]),
		).toEqual([])
		// 03:30 UTC on 2 June 2027 is still 1 June in New York: an entry for
		// 1 June is today there and still checked; at 04:30 UTC it is not.
		const open = entry({ id: 't', date: '2027-06-01', isOpen: true, slots: [] })
		const input = {
			storeHours: week(evening),
			onlineHours: null,
			specialHours: [open],
		}
		expect(
			lintHours(input, {
				now: new Date('2027-06-02T03:30:00Z'),
				timeZone: 'America/New_York',
			}).map((w) => w.code),
		).toEqual(['special_open_without_hours'])
		expect(
			lintHours(input, {
				now: new Date('2027-06-02T04:30:00Z'),
				timeZone: 'America/New_York',
			}),
		).toEqual([])
	})

	it('does not warn about a 24-hour or overnight special day on a DST change day', () => {
		// 14 March 2027 is the US spring-forward day (a 23-hour day).
		const dst = entry({
			id: 'dst',
			date: '2027-06-10',
			isOpen: true,
			slots: [{ start: '00:00', end: '23:59' }],
		})
		const overnight = entry({
			id: 'night',
			date: '2027-11-07',
			isOpen: true,
			slots: [{ start: '20:00', end: '02:00' }],
		})
		expect(lint([dst, overnight])).toEqual([])
	})

	it('checks a repeating entry by its next date', () => {
		const repeating = entry({
			id: 'r',
			date: '2020-12-25',
			isOpen: true,
			slots: [],
			repeatsYearly: true,
		})
		expect(lint([repeating]).map((w) => w.code)).toEqual([
			'special_open_without_hours',
		])
	})
})

describe('hoursFingerprint', () => {
	it('changes when any of the hours change, and is stable otherwise', () => {
		const base = {
			storeHours: week(evening),
			onlineHours: null,
			specialHours: [],
		}
		expect(hoursFingerprint(base)).toBe(hoursFingerprint({ ...base }))
		expect(
			hoursFingerprint({
				...base,
				storeHours: week(evening, {
					monday: [{ start: '10:00', end: '21:00' }],
				}),
			}),
		).not.toBe(hoursFingerprint(base))
		expect(
			hoursFingerprint({
				...base,
				specialHours: [
					{ id: 'x', date: '2027-12-25', isOpen: false, slots: [] },
				],
			}),
		).not.toBe(hoursFingerprint(base))
	})
})
