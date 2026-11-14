import { describe, expect, it } from 'vitest'
import {
	activeBusyExtraPrepMinutes,
	endOfOrderingDay,
	isLocationOpenForOrdering,
	isOrderingPaused,
	nextOrderingOpenAt,
} from './location-availability.ts'
import { type WeeklySchedule } from './location-types.ts'

const everyDay = (start: string, end: string): WeeklySchedule =>
	(
		[
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
			'sunday',
		] as const
	).map((day) => ({ day, isOpen: true, slots: [{ start, end }] }))

// Monday 2026-09-21, 14:30 in New York (EDT, UTC-4).
const NOW = new Date('2026-09-21T18:30:00Z')
const base = {
	timezone: 'America/New_York',
	onlineHours: everyDay('11:00', '22:00'),
	prepTime: 20,
}

describe('isOrderingPaused', () => {
	it('is paused until the end time, then not', () => {
		const location = { orderingPause: { until: '2026-09-21T19:00:00Z' } }
		expect(isOrderingPaused(location, NOW)).toBe(true)
		expect(isOrderingPaused(location, new Date('2026-09-21T19:00:00Z'))).toBe(
			false,
		)
	})

	it('stays paused with no end time and ignores a malformed one', () => {
		expect(isOrderingPaused({ orderingPause: { until: null } }, NOW)).toBe(true)
		expect(isOrderingPaused({ orderingPause: { until: 'nope' } }, NOW)).toBe(
			false,
		)
		expect(isOrderingPaused({ orderingPause: null }, NOW)).toBe(false)
	})
})

describe('activeBusyExtraPrepMinutes', () => {
	it('adds minutes while busy mode lasts', () => {
		const busy = { extraPrepMinutes: 20, until: '2026-09-21T19:00:00Z' }
		expect(activeBusyExtraPrepMinutes({ busyMode: busy }, NOW)).toBe(20)
		expect(
			activeBusyExtraPrepMinutes(
				{ busyMode: busy },
				new Date('2026-09-21T19:00:01Z'),
			),
		).toBe(0)
		expect(
			activeBusyExtraPrepMinutes(
				{ busyMode: { extraPrepMinutes: 10, until: null } },
				NOW,
			),
		).toBe(10)
	})
})

describe('isLocationOpenForOrdering with a pause', () => {
	it('is closed while paused and says when it resumes', () => {
		const result = isLocationOpenForOrdering(
			{ ...base, orderingPause: { until: '2026-09-21T19:00:00Z' } },
			NOW,
		)
		expect(result.isOpen).toBe(false)
		expect(result.status).toBe('closed')
		expect(result.paused).toEqual({
			until: '2026-09-21T19:00:00.000Z',
			resumesAt: '2026-09-21T19:00:00.000Z',
		})
		expect(result.nextOpen).toBe('Online ordering resumes at 3:00 PM')
	})

	it('opens again on its own once the pause ends', () => {
		const result = isLocationOpenForOrdering(
			{ ...base, orderingPause: { until: '2026-09-21T19:00:00Z' } },
			new Date('2026-09-21T19:01:00Z'),
		)
		expect(result.isOpen).toBe(true)
		expect(result.paused).toBeUndefined()
	})

	it('resumes at the next opening when the pause runs past closing', () => {
		// Pause until 23:30 local; closes at 22:00, opens tomorrow 11:00.
		const result = isLocationOpenForOrdering(
			{ ...base, orderingPause: { until: '2026-09-22T03:30:00Z' } },
			NOW,
		)
		expect(result.paused?.resumesAt).toBe('2026-09-22T15:00:00.000Z')
		expect(result.nextOpen).toBe('Online ordering resumes at Tue 11:00 AM')
	})

	it('has no resume time for a pause until turned back on', () => {
		const result = isLocationOpenForOrdering(
			{ ...base, orderingPause: { until: null } },
			NOW,
		)
		expect(result.isOpen).toBe(false)
		expect(result.paused).toEqual({ until: null, resumesAt: null })
		expect(result.nextOpen).toBeUndefined()
	})

	it('adds busy minutes to prep and delivery estimates', () => {
		const result = isLocationOpenForOrdering(
			{ ...base, busyMode: { extraPrepMinutes: 20, until: null } },
			NOW,
		)
		expect(result.isOpen).toBe(true)
		expect(result.estimatedPrepTime).toBe(40)
		expect(result.busyExtraPrepMinutes).toBe(20)
		// Delivery: prep (20) + busy (20, once) + the 25-45 min range.
		expect(result.estimatedDeliveryTime).toEqual({ min: 65, max: 85 })
		expect(result.deliveryTravelTime).toEqual({ min: 25, max: 45 })
	})

	it('keeps an inactive location inactive', () => {
		const result = isLocationOpenForOrdering(
			{ ...base, isActive: false, orderingPause: { until: null } },
			NOW,
		)
		expect(result.reason).toBe('Location is currently inactive')
		expect(result.paused).toBeUndefined()
	})
})

describe('nextOrderingOpenAt', () => {
	it('returns the moment itself while open and the next slot otherwise', () => {
		expect(nextOrderingOpenAt(base, NOW)).toEqual(NOW)
		expect(
			nextOrderingOpenAt(base, new Date('2026-09-21T12:00:00Z'))?.toISOString(),
		).toBe('2026-09-21T15:00:00.000Z')
	})

	it('honours special hours and skips closed days', () => {
		const location = {
			...base,
			specialHours: [{ date: '2026-09-22', isOpen: false, slots: [] }],
		}
		expect(
			nextOrderingOpenAt(
				location,
				new Date('2026-09-22T03:00:00Z'),
			)?.toISOString(),
		).toBe('2026-09-23T15:00:00.000Z')
	})

	it('is the same instant when no schedule is published', () => {
		expect(nextOrderingOpenAt({ timezone: 'UTC' }, NOW)).toEqual(NOW)
	})
})

describe('endOfOrderingDay', () => {
	it('is local midnight', () => {
		expect(endOfOrderingDay(base, NOW).toISOString()).toBe(
			'2026-09-22T04:00:00.000Z',
		)
	})

	it('follows an overnight stretch past midnight', () => {
		const location = {
			...base,
			onlineHours: everyDay('00:00', '02:00').map((day) => ({
				...day,
				slots: [
					{ start: '00:00', end: '02:00' },
					{ start: '18:00', end: '23:59' },
				],
			})),
		}
		expect(endOfOrderingDay(location, NOW).toISOString()).toBe(
			'2026-09-22T06:01:00.000Z',
		)
	})

	it('is DST-safe on the night clocks go back', () => {
		// New York leaves DST at 02:00 on Sunday 2026-11-01: midnight is EDT.
		const saturday = new Date('2026-10-31T20:00:00Z')
		expect(endOfOrderingDay(base, saturday).toISOString()).toBe(
			'2026-11-01T04:00:00.000Z',
		)
		const sunday = new Date('2026-11-01T20:00:00Z')
		expect(endOfOrderingDay(base, sunday).toISOString()).toBe(
			'2026-11-02T05:00:00.000Z',
		)
	})
})
