import { describe, expect, it } from 'vitest'
import {
	bottleSpecProblem,
	bottlesAndWeightToMl,
	bottlesToMl,
	canCountByWeight,
	mlToBottleParts,
	openBottleMlFromWeight,
} from './bottles.ts'

const spec = { sizeMl: 700, fullWeightG: 1300, emptyWeightG: 500 }

describe('counting open bottles (#470)', () => {
	it('records 3 full bottles and one at 0.4 as 3.4 bottles in millilitres', () => {
		expect(bottlesToMl(spec, 3, 4)).toBe(2380)
		expect(bottlesToMl({ sizeMl: 750 }, 0, 10)).toBe(750)
		expect(bottlesToMl({ sizeMl: 700 }, 0, 0)).toBe(0)
		// Tenths of an odd size round to the nearest millilitre.
		expect(bottlesToMl({ sizeMl: 355 }, 1, 3)).toBe(355 + 107)
	})

	it('turns a typed weight of the open bottle into millilitres from the full and empty weights', () => {
		// (700 - 500) / (1300 - 500) = a quarter of 700 ml.
		expect(openBottleMlFromWeight(spec, 700)).toBe(175)
		expect(openBottleMlFromWeight(spec, 500)).toBe(0)
		expect(openBottleMlFromWeight(spec, 1300)).toBe(700)
		// A scale that is a few grams off never goes below empty or above full.
		expect(openBottleMlFromWeight(spec, 480)).toBe(0)
		expect(openBottleMlFromWeight(spec, 1320)).toBe(700)
		expect(bottlesAndWeightToMl(spec, 3, 700)).toBe(2275)
	})

	it('needs both weights to count by weight', () => {
		expect(canCountByWeight(spec)).toBe(true)
		expect(
			canCountByWeight({ sizeMl: 700, fullWeightG: 1300, emptyWeightG: null }),
		).toBe(false)
		expect(
			openBottleMlFromWeight(
				{ sizeMl: 700, fullWeightG: null, emptyWeightG: null },
				700,
			),
		).toBeNull()
		expect(
			bottlesAndWeightToMl(
				{ sizeMl: 700, fullWeightG: null, emptyWeightG: null },
				1,
				700,
			),
		).toBeNull()
	})

	it('splits a stored amount back into bottles and tenths', () => {
		expect(mlToBottleParts({ sizeMl: 700 }, 2380)).toEqual({
			whole: 3,
			openTenths: 4,
		})
		// 9.6 tenths rounds up into the next whole bottle.
		expect(mlToBottleParts({ sizeMl: 700 }, 700 * 2 + 680)).toEqual({
			whole: 3,
			openTenths: 0,
		})
		expect(mlToBottleParts({ sizeMl: 700 }, 0)).toEqual({
			whole: 0,
			openTenths: 0,
		})
	})

	it('refuses impossible counts and specs', () => {
		expect(() => bottlesToMl(spec, -1, 0)).toThrow(RangeError)
		expect(() => bottlesToMl(spec, 1.5, 0)).toThrow(RangeError)
		expect(() => bottlesToMl(spec, 1, 11)).toThrow(RangeError)
		expect(() => openBottleMlFromWeight(spec, -1)).toThrow(RangeError)
		expect(
			bottleSpecProblem({
				sizeMl: null,
				fullWeightG: null,
				emptyWeightG: null,
			}),
		).toBe('size_required')
		expect(
			bottleSpecProblem({ sizeMl: 700, fullWeightG: 1300, emptyWeightG: null }),
		).toBe('weights_pair')
		expect(
			bottleSpecProblem({ sizeMl: 700, fullWeightG: 500, emptyWeightG: 700 }),
		).toBe('full_not_heavier')
		expect(
			bottleSpecProblem({
				sizeMl: 700,
				...{ fullWeightG: null, emptyWeightG: null },
			}),
		).toBeNull()
		expect(bottleSpecProblem(spec)).toBeNull()
	})
})
