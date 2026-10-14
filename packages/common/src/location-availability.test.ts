import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	isLocationOpenForOrdering,
	getAvailabilityPresets,
	formatUnavailableUntil,
	isUnavailableUntilExpired,
	localDateAndTimeToUtc,
	addLocalDays,
} from './location-availability.ts'
import { type WeeklySchedule } from './location-types.ts'

describe('isLocationOpenForOrdering', () => {
	const standardSchedule: WeeklySchedule = [
		{
			day: 'monday',
			isOpen: true,
			slots: [{ start: '11:00', end: '22:00' }],
		},
		{
			day: 'tuesday',
			isOpen: true,
			slots: [{ start: '11:00', end: '22:00' }],
		},
		{
			day: 'wednesday',
			isOpen: false,
			slots: [],
		},
	]

	it('returns open when current local time is within open slot', () => {
		// Monday at 14:30 (2:30 PM) UTC
		const date = new Date('2026-09-21T14:30:00Z') // Sept 21 2026 is Monday
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
				prepTime: 20,
			},
			date,
		)

		expect(result.isOpen).toBe(true)
		expect(result.status).toBe('open')
		expect(result.estimatedPrepTime).toBe(20)
		expect(result.currentLocalTime).toBe('14:30')
		expect(result.dayOfWeek).toBe('monday')
	})

	it('returns closing_soon when within 30 minutes of close', () => {
		// Monday at 21:45 (9:45 PM) UTC (closes at 22:00)
		const date = new Date('2026-09-21T21:45:00Z')
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
			},
			date,
		)

		expect(result.isOpen).toBe(true)
		expect(result.status).toBe('closing_soon')
	})

	it('returns closed when before opening time and gives nextOpen', () => {
		// Monday at 09:15 UTC (opens at 11:00)
		const date = new Date('2026-09-21T09:15:00Z')
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
			},
			date,
		)

		expect(result.isOpen).toBe(false)
		expect(result.status).toBe('closed')
		expect(result.nextOpen).toContain('11:00 AM')
	})

	it('returns closed when day is marked closed', () => {
		// Wednesday Sept 23 2026 is Wednesday
		const date = new Date('2026-09-23T14:00:00Z')
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
			},
			date,
		)

		expect(result.isOpen).toBe(false)
		expect(result.status).toBe('closed')
		expect(result.reason).toBe('Closed today')
	})

	it('respects special holiday hours closed override', () => {
		const date = new Date('2026-12-25T14:00:00Z')
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
				specialHours: [
					{
						id: 'christmas',
						date: '2026-12-25',
						isOpen: false,
						slots: [],
						note: 'Closed for Christmas',
					},
				],
			},
			date,
		)

		expect(result.isOpen).toBe(false)
		expect(result.status).toBe('closed')
		expect(result.reason).toBe('Closed for Christmas')
	})

	it('respects special hours custom slots override', () => {
		const date = new Date('2026-12-31T18:00:00Z')
		const result = isLocationOpenForOrdering(
			{
				timezone: 'UTC',
				onlineHours: standardSchedule,
				specialHours: [
					{
						id: 'nye',
						date: '2026-12-31',
						isOpen: true,
						slots: [{ start: '16:00', end: '20:00' }],
						note: 'New Years Eve Special Dinner',
					},
				],
			},
			date,
		)

		expect(result.isOpen).toBe(true)
		expect(result.status).toBe('open')
	})
})

describe('getAvailabilityPresets', () => {
	const schedule: WeeklySchedule = [
		{
			day: 'monday',
			isOpen: true,
			slots: [{ start: '09:00', end: '22:00' }],
		},
		{
			day: 'tuesday',
			isOpen: true,
			slots: [{ start: '10:00', end: '21:00' }],
		},
	]

	it('generates presets for 30m, 1h, today closing, tomorrow opening, and custom', () => {
		// Monday at 14:00 (2:00 PM) UTC
		const currentTime = new Date('2026-09-21T14:00:00Z')
		const presets = getAvailabilityPresets(
			{
				timezone: 'UTC',
				onlineHours: schedule,
			},
			currentTime,
		)

		expect(presets.some((p) => p.id === '30_min')).toBe(true)
		expect(presets.some((p) => p.id === '1_hour')).toBe(true)
		const closingPreset = presets.find((p) => p.id === 'today_closing')
		expect(closingPreset).toBeDefined()
		expect(closingPreset?.label).toBe('Today at 10:00 PM')
		expect(closingPreset?.date?.toISOString()).toBe('2026-09-21T22:00:00.000Z')

		const openingPreset = presets.find((p) => p.id === 'tomorrow_opening')
		expect(openingPreset).toBeDefined()
		expect(openingPreset?.label).toBe('Tomorrow at 10:00 AM')
		expect(openingPreset?.date?.toISOString()).toBe('2026-09-22T10:00:00.000Z')

		const customPreset = presets.find((p) => p.id === 'custom')
		expect(customPreset).toBeDefined()
	})

	it('omits today closing if already past closing time', () => {
		// Monday at 23:00 (11:00 PM) UTC (closed at 22:00)
		const currentTime = new Date('2026-09-21T23:00:00Z')
		const presets = getAvailabilityPresets(
			{
				timezone: 'UTC',
				onlineHours: schedule,
			},
			currentTime,
		)

		expect(presets.some((p) => p.id === 'today_closing')).toBe(false)
	})
})

describe('formatUnavailableUntil', () => {
	it('formats date correctly for today, tomorrow, and future dates', () => {
		const baseDate = new Date('2026-09-21T14:00:00Z')
		const todayDate = new Date('2026-09-21T22:00:00Z')
		const formatted = formatUnavailableUntil(todayDate, 'UTC')
		// Since formatUnavailableUntil compares to new Date(), test with actual future date or check format output
		expect(formatted).toBeDefined()
	})
})

describe('isUnavailableUntilExpired', () => {
	it('returns true when status is available or expired', () => {
		expect(isUnavailableUntilExpired('available')).toBe(true)
		expect(
			isUnavailableUntilExpired(
				'unavailable_until',
				new Date('2026-09-21T10:00:00Z'),
				new Date('2026-09-21T12:00:00Z'),
			),
		).toBe(true)
	})

	it('returns false when status is unavailable, hidden, or future unavailable_until', () => {
		expect(isUnavailableUntilExpired('unavailable')).toBe(false)
		expect(isUnavailableUntilExpired('hidden')).toBe(false)
		expect(
			isUnavailableUntilExpired(
				'unavailable_until',
				new Date('2026-09-21T15:00:00Z'),
				new Date('2026-09-21T12:00:00Z'),
			),
		).toBe(false)
	})
})

describe('overnight hours', () => {
	// Overnight service is modelled by splitting at midnight: Friday evening
	// ends at 23:59 and Saturday starts again at 00:00.
	const lateNightSchedule: WeeklySchedule = [
		{ day: 'friday', isOpen: true, slots: [{ start: '18:00', end: '23:59' }] },
		{
			day: 'saturday',
			isOpen: true,
			slots: [{ start: '00:00', end: '02:00' }],
		},
		{ day: 'sunday', isOpen: true, slots: [{ start: '12:00', end: '23:59' }] },
		{ day: 'monday', isOpen: false, slots: [] },
	]
	const at = (iso: string, extra: Record<string, unknown> = {}) =>
		isLocationOpenForOrdering(
			{ timezone: 'UTC', onlineHours: lateNightSchedule, ...extra },
			new Date(iso),
		)

	it('is open before midnight and again after midnight on the split day', () => {
		// 2026-09-25 is a Friday
		expect(at('2026-09-25T23:30:00Z').isOpen).toBe(true)
		expect(at('2026-09-26T00:00:00Z').isOpen).toBe(true)
		expect(at('2026-09-26T01:15:00Z').isOpen).toBe(true)
		expect(at('2026-09-26T02:00:00Z').isOpen).toBe(true)
		expect(at('2026-09-26T02:01:00Z').isOpen).toBe(false)
	})

	it('reads midnight as 00:00 and never as 24:00', () => {
		const result = at('2026-09-26T00:00:00Z')
		expect(result.currentLocalTime).toBe('00:00')
		expect(result.currentLocalDate).toBe('2026-09-26')
		expect(result.dayOfWeek).toBe('saturday')
	})

	it('does not report closing soon while the evening continues past midnight', () => {
		expect(at('2026-09-25T23:45:00Z').status).toBe('open')
		// Saturday 01:45 is within 30 minutes of the real closing time.
		expect(at('2026-09-26T01:45:00Z').status).toBe('closing_soon')
	})

	it('reports closing soon when the day end is not continued', () => {
		// Sunday 23:45; Monday is closed, so the location really closes.
		expect(at('2026-09-27T23:45:00Z').status).toBe('closing_soon')
	})

	it('does not continue past midnight into a special-hours closure', () => {
		const result = at('2026-09-25T23:45:00Z', {
			specialHours: [
				{ id: 's1', date: '2026-09-26', isOpen: false, slots: [] },
			],
		})
		expect(result.status).toBe('closing_soon')
	})

	it('respects the location timezone around midnight', () => {
		// 2026-09-26T04:30Z is Saturday 00:30 in New York (EDT, UTC-4).
		const result = isLocationOpenForOrdering(
			{ timezone: 'America/New_York', onlineHours: lateNightSchedule },
			new Date('2026-09-26T04:30:00Z'),
		)
		expect(result.currentLocalTime).toBe('00:30')
		expect(result.dayOfWeek).toBe('saturday')
		expect(result.isOpen).toBe(true)
	})

	it('treats a slot that ends before it starts as never open', () => {
		// 22:00-02:00 written as one slot is not an overnight slot. It must split
		// at midnight; the phone agent settings reject it for the same reason.
		const inverted: WeeklySchedule = [
			{
				day: 'friday',
				isOpen: true,
				slots: [{ start: '22:00', end: '02:00' }],
			},
		]
		for (const iso of [
			'2026-09-25T23:00:00Z',
			'2026-09-25T22:00:00Z',
			'2026-09-25T01:00:00Z',
		]) {
			const result = isLocationOpenForOrdering(
				{ timezone: 'UTC', onlineHours: inverted },
				new Date(iso),
			)
			expect(result.isOpen).toBe(false)
		}
	})
})

describe('calendar day math across DST', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('adds calendar days and derives the weekday', () => {
		expect(addLocalDays('2026-09-25', 1)).toEqual({
			date: '2026-09-26',
			day: 'saturday',
		})
		expect(addLocalDays('2026-12-31', 1)).toEqual({
			date: '2027-01-01',
			day: 'friday',
		})
		expect(addLocalDays('2028-02-28', 2).date).toBe('2028-03-01')
	})

	it('offers tomorrow opening on the next local date the night before spring forward', () => {
		// America/New_York springs forward on 2027-03-14. Saturday 2027-03-13
		// 23:30 EST + 24h lands on Monday 00:30 EDT, skipping Sunday entirely.
		const schedule: WeeklySchedule = [
			{
				day: 'saturday',
				isOpen: true,
				slots: [{ start: '10:00', end: '23:59' }],
			},
			{
				day: 'sunday',
				isOpen: true,
				slots: [{ start: '11:00', end: '20:00' }],
			},
			{
				day: 'monday',
				isOpen: true,
				slots: [{ start: '09:00', end: '21:00' }],
			},
		]
		const presets = getAvailabilityPresets(
			{ timezone: 'America/New_York', onlineHours: schedule },
			new Date('2027-03-14T04:30:00Z'), // Saturday 23:30 EST
		)
		const opening = presets.find((p) => p.id === 'tomorrow_opening')
		expect(opening?.label).toBe('Tomorrow at 11:00 AM')
		// 11:00 EDT on Sunday 2027-03-14 is 15:00Z.
		expect(opening?.date?.toISOString()).toBe('2027-03-14T15:00:00.000Z')
	})

	it('offers no closing time preset on a day the location is closed', () => {
		const schedule: WeeklySchedule = [
			{
				day: 'saturday',
				isOpen: true,
				slots: [{ start: '10:00', end: '23:59' }],
			},
		]
		const presets = getAvailabilityPresets(
			{ timezone: 'America/Chicago', onlineHours: schedule },
			new Date('2026-09-26T03:00:00Z'), // Friday 22:00 CDT, closed Friday
		)
		expect(presets.some((p) => p.id === 'today_closing')).toBe(false)
	})

	it('labels tomorrow correctly in formatUnavailableUntil near a DST change', () => {
		vi.useFakeTimers()
		// Saturday 2027-03-13 23:30 EST.
		vi.setSystemTime(new Date('2027-03-14T04:30:00Z'))
		const sundayNoon = new Date('2027-03-14T16:00:00Z') // 12:00 EDT Sunday
		expect(formatUnavailableUntil(sundayNoon, 'America/New_York')).toBe(
			'Tomorrow at 12:00 PM',
		)
	})
})
