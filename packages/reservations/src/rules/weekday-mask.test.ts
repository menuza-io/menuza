import { describe, expect, it } from 'vitest'
import {
	maskIncludesWeekday,
	maskToUiDays,
	uiDaysToMask,
	weekdayToMaskBit,
} from './weekday-mask.ts'

describe('weekday masks are Monday-first, UI weekdays Sunday-first', () => {
	it('maps each UI weekday to its Monday-first bit', () => {
		// Sunday=0 -> bit 6, Monday=1 -> bit 0 ... Saturday=6 -> bit 5
		expect([0, 1, 2, 3, 4, 5, 6].map(weekdayToMaskBit)).toEqual([
			6, 0, 1, 2, 3, 4, 5,
		])
		expect(uiDaysToMask([1])).toBe(0b0000001)
		expect(uiDaysToMask([0])).toBe(0b1000000)
		expect(uiDaysToMask([2])).toBe(0b0000010)
		expect(uiDaysToMask([6])).toBe(0b0100000)
	})

	it('round-trips every single day and every mask', () => {
		for (let d = 0; d <= 6; d++) {
			expect(maskToUiDays(uiDaysToMask([d]))).toEqual([d])
		}
		for (let mask = 0; mask <= 127; mask++) {
			expect(uiDaysToMask(maskToUiDays(mask))).toBe(mask)
		}
	})

	it('ignores invalid weekdays and answers membership by weekday', () => {
		expect(uiDaysToMask([-1, 7, 1.5, 3])).toBe(uiDaysToMask([3]))
		expect(maskIncludesWeekday(0b0000001, 1)).toBe(true)
		expect(maskIncludesWeekday(0b0000001, 2)).toBe(false)
		expect(maskIncludesWeekday(0b1000000, 0)).toBe(true)
	})
})
