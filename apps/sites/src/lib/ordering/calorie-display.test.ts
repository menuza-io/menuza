import { describe, expect, it } from 'vitest'
import { guestCalorieNumbers, pageShowsCalories } from './calorie-display.ts'

describe('guest calorie display', () => {
	it('never removes calories from the menu, the dish and a selected option range', () => {
		expect(pageShowsCalories([{ showCalories: false }])).toBe(false)
		expect(
			guestCalorieNumbers({
				show: false,
				calorieMin: 200,
				calorieMax: 240,
				optionCalories: [50],
			}),
		).toBeNull()
		expect(
			guestCalorieNumbers({
				show: true,
				calorieMin: 200,
				calorieMax: 240,
				optionCalories: [50],
				dataRegion: 'us',
			}),
		).toEqual({ min: 200, max: 290, intake: 'us' })
	})

	it('complete with gaps is already showCalories false from the payload', () => {
		expect(
			pageShowsCalories([{ showCalories: false, dailyIntake: null }]),
		).toBe(false)
	})
})
