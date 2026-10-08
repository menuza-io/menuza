import { describe, expect, it } from 'vitest'
import { type ScheduleDay, withCurrentAvailability } from '@repo/phone-agent'
import { type AgentLocation, restaurantAvailability } from './location.ts'
import { restaurantVertical } from './vertical.ts'

const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
]

function week(slots: Array<{ start: string; end: string }>): ScheduleDay[] {
	return WEEKDAYS.map((day) => ({ day, isOpen: true, slots }))
}

function location(
	overrides: Partial<AgentLocation> & { isActive?: boolean } = {},
) {
	return {
		timezone: 'America/New_York',
		storeHours: week([{ start: '09:00', end: '17:00' }]),
		onlineHours: week([{ start: '11:00', end: '16:00' }]),
		specialHours: [],
		...overrides,
	}
}

// Wednesday 2025-01-15 in New York (UTC-5).
const at = (time: string) => new Date(`2025-01-15T${time}:00-05:00`)

describe('restaurantAvailability', () => {
	it('follows store hours for open and online hours for ordering', () => {
		expect(restaurantAvailability(location(), at('10:00'))).toEqual({
			isOpen: true,
			nextOpen: null,
			orderingOpen: false,
		})
		expect(restaurantAvailability(location(), at('12:00'))).toEqual({
			isOpen: true,
			nextOpen: null,
			orderingOpen: true,
		})
	})

	it('evaluates the hours in the location timezone', () => {
		const pacific = location({ timezone: 'America/Los_Angeles' })
		// 10:00 in New York is 07:00 in Los Angeles.
		expect(restaurantAvailability(pacific, at('10:00')).isOpen).toBe(false)
		expect(restaurantAvailability(pacific, at('13:00')).isOpen).toBe(true)
	})

	it('says when a closed store opens later today', () => {
		expect(restaurantAvailability(location(), at('07:30'))).toEqual({
			isOpen: false,
			nextOpen: 'Opens today at 9:00 AM',
			orderingOpen: false,
		})
		expect(restaurantAvailability(location(), at('20:00'))).toEqual({
			isOpen: false,
			nextOpen: null,
			orderingOpen: false,
		})
	})

	it('lets special hours override the week', () => {
		const holiday = location({
			specialHours: [{ date: '2025-01-15', isOpen: false, slots: [] }],
		})
		expect(restaurantAvailability(holiday, at('12:00'))).toMatchObject({
			isOpen: false,
			orderingOpen: false,
		})
		const late = location({
			specialHours: [
				{
					date: '2025-01-15',
					isOpen: true,
					slots: [{ start: '18:00', end: '23:00' }],
				},
			],
		})
		expect(restaurantAvailability(late, at('20:00')).isOpen).toBe(true)
	})

	it('treats a closed day and an inactive location as closed', () => {
		const closedWednesday = location({
			storeHours: week([{ start: '09:00', end: '17:00' }]).map((day) =>
				day.day === 'wednesday' ? { ...day, isOpen: false } : day,
			),
		})
		expect(restaurantAvailability(closedWednesday, at('12:00')).isOpen).toBe(
			false,
		)
		expect(
			restaurantAvailability(location({ isActive: false }), at('12:00')),
		).toMatchObject({ isOpen: false, orderingOpen: false })
	})

	it('is open when no hours are published', () => {
		expect(
			restaurantAvailability(
				location({ storeHours: [], onlineHours: [] }),
				at('03:00'),
			),
		).toEqual({ isOpen: true, nextOpen: null, orderingOpen: true })
	})

	it('falls back to online hours when there are no store hours', () => {
		const onlineOnly = location({ storeHours: [] })
		expect(restaurantAvailability(onlineOnly, at('10:00')).isOpen).toBe(false)
		expect(restaurantAvailability(onlineOnly, at('12:00')).isOpen).toBe(true)
	})
})

describe('withCurrentAvailability for restaurants', () => {
	it('replaces the snapshot App took with the state at call time', () => {
		const config = {
			availability: { isOpen: true, nextOpen: null },
			vertical: {
				id: 'restaurant',
				data: {
					location: { id: 'loc', name: 'Downtown', ...location() },
					menus: [],
					orderingOpen: true,
				},
			},
		} as unknown as Parameters<typeof withCurrentAvailability>[0]
		const current = withCurrentAvailability(
			config,
			restaurantVertical,
			at('20:00'),
		)
		expect(current.availability).toEqual({ isOpen: false, nextOpen: null })
		expect(current.vertical.data).toMatchObject({ orderingOpen: false })
	})
})
