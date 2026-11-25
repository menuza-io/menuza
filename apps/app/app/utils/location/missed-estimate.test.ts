import { describe, expect, it } from 'vitest'
import {
	formatPauseLength,
	summarizeEntry,
	weekdayName,
} from './missed-estimate.ts'

describe('missed estimate helpers (#176)', () => {
	it('sums the pieces of a pause and says not enough history as soon as one piece is', () => {
		expect(
			summarizeEntry([
				{ id: 'a|0', enough: true, orders: 8, salesMinor: 24000, weeksUsed: 4 },
				{ id: 'a|1', enough: true, orders: 6, salesMinor: 17000, weeksUsed: 3 },
			]),
		).toEqual({ status: 'enough', orders: 14, salesMinor: 41000, weeksUsed: 3 })
		expect(
			summarizeEntry([
				{ id: 'a|0', enough: true, orders: 8, salesMinor: 24000, weeksUsed: 4 },
				{ id: 'a|1', enough: false, weeksUsed: 1 },
			]),
		).toEqual({ status: 'not_enough' })
		expect(summarizeEntry([])).toEqual({ status: 'not_enough' })
	})

	it('writes a pause length and a weekday in the viewer locale', () => {
		expect(formatPauseLength(100, 'en')).toMatch(/1.*h.*40.*m/)
		expect(formatPauseLength(45, 'en')).toMatch(/45.*m/)
		expect(formatPauseLength(0, 'en')).toMatch(/0.*m/)
		expect(weekdayName(5, 'en')).toBe('Friday')
		expect(weekdayName(0, 'en')).toBe('Sunday')
		// Arabic words, not English ones.
		expect(weekdayName(5, 'ar')).not.toBe('Friday')
	})
})
