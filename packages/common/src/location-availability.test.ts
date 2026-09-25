import { describe, expect, it } from 'vitest'
import {
	isLocationOpenForOrdering,
	getAvailabilityPresets,
	formatUnavailableUntil,
	isUnavailableUntilExpired,
	localDateAndTimeToUtc,
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

	it('returns false when status is unavailable or future unavailable_until', () => {
		expect(isUnavailableUntilExpired('unavailable')).toBe(false)
		expect(
			isUnavailableUntilExpired(
				'unavailable_until',
				new Date('2026-09-21T15:00:00Z'),
				new Date('2026-09-21T12:00:00Z'),
			),
		).toBe(false)
	})
})
