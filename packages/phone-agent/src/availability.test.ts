import { describe, expect, it } from 'vitest'
import {
	availabilityFromSchedule,
	type ScheduleInput,
	withCurrentAvailability,
} from './availability.ts'
import { type PhoneAgentRuntimeConfig } from './config.ts'

const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
]

function week(slots: Array<{ start: string; end: string }>) {
	return WEEKDAYS.map((day) => ({ day, isOpen: true, slots }))
}

function schedule(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
	return {
		timezone: 'America/New_York',
		hours: week([{ start: '09:00', end: '17:00' }]),
		specialHours: [],
		...overrides,
	}
}

// Wednesday 2025-01-15 in New York (UTC-5).
const at = (time: string) => new Date(`2025-01-15T${time}:00-05:00`)

describe('availabilityFromSchedule', () => {
	it('is open inside the weekly hours', () => {
		expect(availabilityFromSchedule(schedule(), at('10:00'))).toEqual({
			isOpen: true,
			nextOpen: null,
		})
	})

	it('evaluates the hours in the schedule timezone', () => {
		const pacific = schedule({ timezone: 'America/Los_Angeles' })
		// 10:00 in New York is 07:00 in Los Angeles.
		expect(availabilityFromSchedule(pacific, at('10:00')).isOpen).toBe(false)
		expect(availabilityFromSchedule(pacific, at('13:00')).isOpen).toBe(true)
	})

	it('says when it opens later today', () => {
		expect(availabilityFromSchedule(schedule(), at('07:30'))).toEqual({
			isOpen: false,
			nextOpen: 'Opens today at 9:00 AM',
		})
		expect(availabilityFromSchedule(schedule(), at('20:00'))).toEqual({
			isOpen: false,
			nextOpen: null,
		})
	})

	it('lets special hours override the week', () => {
		const holiday = schedule({
			specialHours: [{ date: '2025-01-15', isOpen: false, slots: [] }],
		})
		expect(availabilityFromSchedule(holiday, at('12:00')).isOpen).toBe(false)
		const late = schedule({
			specialHours: [
				{
					date: '2025-01-15',
					isOpen: true,
					slots: [{ start: '18:00', end: '23:00' }],
				},
			],
		})
		expect(availabilityFromSchedule(late, at('20:00')).isOpen).toBe(true)
	})

	it('treats a closed day and an inactive schedule as closed', () => {
		const closedWednesday = schedule({
			hours: week([{ start: '09:00', end: '17:00' }]).map((day) =>
				day.day === 'wednesday' ? { ...day, isOpen: false } : day,
			),
		})
		expect(availabilityFromSchedule(closedWednesday, at('12:00')).isOpen).toBe(
			false,
		)
		expect(
			availabilityFromSchedule(schedule({ isActive: false }), at('12:00'))
				.isOpen,
		).toBe(false)
	})

	it('is open when no hours are published', () => {
		expect(
			availabilityFromSchedule(schedule({ hours: [] }), at('03:00')),
		).toEqual({ isOpen: true, nextOpen: null })
	})

	it('falls back to UTC for an unknown timezone', () => {
		expect(
			availabilityFromSchedule(schedule({ timezone: 'Mars/Base' }), at('10:00'))
				.isOpen,
		).toBe(true)
	})
})

describe('withCurrentAvailability', () => {
	const config = {
		business: {
			timezone: 'America/New_York',
			hours: week([{ start: '09:00', end: '17:00' }]),
			specialHours: [],
		},
		availability: { isOpen: true, nextOpen: null },
		vertical: { id: 'general', data: null },
	} as unknown as PhoneAgentRuntimeConfig

	it('replaces the snapshot App took with the state at call time', () => {
		expect(
			withCurrentAvailability(config, null, at('20:00')).availability,
		).toEqual({
			isOpen: false,
			nextOpen: null,
		})
	})

	it('lets the vertical recompute availability and its data', () => {
		const next = withCurrentAvailability(
			config,
			{
				currentAvailability: () => ({
					availability: { isOpen: false, nextOpen: 'Soon' },
					data: { refreshed: true },
				}),
			},
			at('12:00'),
		)
		expect(next.availability).toEqual({ isOpen: false, nextOpen: 'Soon' })
		expect(next.vertical).toEqual({ id: 'general', data: { refreshed: true } })
	})

	it('keeps the snapshot when the vertical throws', () => {
		const warn = console.warn
		console.warn = () => undefined
		try {
			expect(
				withCurrentAvailability(config, {
					currentAvailability: () => {
						throw new Error('bad data')
					},
				}),
			).toBe(config)
		} finally {
			console.warn = warn
		}
	})
})
