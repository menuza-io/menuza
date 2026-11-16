import { describe, expect, it } from 'vitest'
import { weeklyScheduleHasOpenDay } from './hours.ts'

describe('weeklyScheduleHasOpenDay', () => {
	it('is true when at least one day is open with a slot', () => {
		expect(
			weeklyScheduleHasOpenDay([
				{ day: 'monday', isOpen: false, slots: [] },
				{
					day: 'tuesday',
					isOpen: true,
					slots: [{ start: '10:00', end: '20:00' }],
				},
			]),
		).toBe(true)
	})

	it('is false for missing or empty schedules', () => {
		expect(weeklyScheduleHasOpenDay(null)).toBe(false)
		expect(weeklyScheduleHasOpenDay([])).toBe(false)
	})
})
