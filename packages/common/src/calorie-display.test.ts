import { describe, expect, it } from 'vitest'
import {
	calorieRangeWithOptions,
	guestCalorieView,
	resolveCalorieDisplay,
} from './calorie-display.ts'

const dish = { calorieMin: 400, calorieMax: 400 }
const gap = { calorieMin: null, calorieMax: null }

describe('resolveCalorieDisplay', () => {
	it('never hides calories on every guest surface and keeps the stored range', () => {
		const resolved = resolveCalorieDisplay({
			orgMode: 'never',
			missingCount: 0,
		})
		expect(resolved.show).toBe(false)
		const view = guestCalorieView({ show: resolved.show, dish })
		expect(view.visible).toBe(false)
		expect(dish.calorieMin).toBe(400)
	})

	it('complete hides a menu with gaps and reports how many dishes are missing', () => {
		const resolved = resolveCalorieDisplay({
			orgMode: 'complete',
			missingCount: 3,
		})
		expect(resolved).toEqual({ mode: 'complete', show: false, missingCount: 3 })
		expect(guestCalorieView({ show: resolved.show, dish }).visible).toBe(false)
	})

	it('complete shows calories once every dish has them', () => {
		const resolved = resolveCalorieDisplay({
			orgMode: 'complete',
			missingCount: 0,
		})
		expect(resolved.show).toBe(true)
		expect(guestCalorieView({ show: true, dish, dataRegion: 'ksa' })).toEqual({
			visible: true,
			min: 400,
			max: 400,
			intake: 'ksa',
		})
	})

	it('a menu override wins over the organization', () => {
		expect(
			resolveCalorieDisplay({
				orgMode: 'always',
				menuMode: 'never',
				missingCount: 0,
			}).show,
		).toBe(false)
	})

	it('an older menu with nutritional info off hides calories', () => {
		expect(
			resolveCalorieDisplay({
				orgMode: 'always',
				nutritionalInfo: false,
				missingCount: 0,
			}).mode,
		).toBe('never')
	})
})

describe('calorieRangeWithOptions', () => {
	it('adds selected option calories to the top of the range', () => {
		expect(
			calorieRangeWithOptions({ calorieMin: 200, calorieMax: 260 }, [
				80,
				null,
				40,
			]),
		).toEqual({ min: 200, max: 380 })
	})

	it('returns nothing when the dish has no calories', () => {
		expect(calorieRangeWithOptions(gap, [10])).toBeNull()
		expect(guestCalorieView({ show: true, dish: gap }).visible).toBe(false)
	})

	it('names the US and KSA daily-intake statements and no other market', () => {
		expect(
			guestCalorieView({ show: true, dish, dataRegion: 'us' }),
		).toMatchObject({ intake: 'us' })
		expect(
			guestCalorieView({ show: true, dish, dataRegion: 'ae' }),
		).toMatchObject({ intake: null })
	})
})
