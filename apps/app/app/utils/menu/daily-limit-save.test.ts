import { parseDailySaleLimit } from '@repo/common/daily-dish-limits'
import { describe, expect, it } from 'vitest'
import {
	dailyLimitColumn,
	dailyLimitLocationIds,
	optionLimitLocationIds,
	optionsCarryingDailyLimit,
} from './daily-limit-save.ts'

const limited = parseDailySaleLimit({
	limit: 20,
	byLocation: { a: 5, b: null },
})

describe('dailyLimitColumn', () => {
	it('writes the serialized limit when the form posted it', () => {
		expect(dailyLimitColumn(true, limited)).toEqual({
			dailySaleLimit: JSON.stringify(limited),
		})
	})

	it('writes null (clears) when the form posted no limit', () => {
		expect(dailyLimitColumn(true, null)).toEqual({ dailySaleLimit: null })
		expect(dailyLimitColumn(true, undefined)).toEqual({ dailySaleLimit: null })
	})

	it('writes nothing when the form did not post it, so a stored limit stays', () => {
		expect(dailyLimitColumn(false, null)).toEqual({})
		expect('dailySaleLimit' in dailyLimitColumn(false, limited)).toBe(false)
	})
})

describe('location ids', () => {
	it('lists the locations a limit names', () => {
		expect(dailyLimitLocationIds(limited).sort()).toEqual(['a', 'b'])
		expect(dailyLimitLocationIds(null)).toEqual([])
		expect(dailyLimitLocationIds(parseDailySaleLimit({ limit: 3 }))).toEqual([])
	})

	it('lists every location the options name, once', () => {
		const one = parseDailySaleLimit({ limit: 3, byLocation: { a: 1 } })
		const two = parseDailySaleLimit({ limit: 3, byLocation: { a: 2, c: 4 } })
		expect(
			optionLimitLocationIds([
				{ dailySaleLimit: one },
				{ dailySaleLimit: two },
				{ dailySaleLimit: null },
				{},
			]).sort(),
		).toEqual(['a', 'c'])
	})
})

describe('optionsCarryingDailyLimit', () => {
	it('tells cleared from never sent, by position', () => {
		expect(
			optionsCarryingDailyLimit([
				{ id: 'x', dailySaleLimit: null },
				{ id: 'y' },
				{ id: 'z', dailySaleLimit: { limit: 5 } },
			]),
		).toEqual([true, false, true])
	})

	it('is empty for anything that is not a list of objects', () => {
		expect(optionsCarryingDailyLimit(undefined)).toEqual([])
		expect(optionsCarryingDailyLimit('nope')).toEqual([])
		expect(optionsCarryingDailyLimit([null, 3, 'x'])).toEqual([
			false,
			false,
			false,
		])
	})
})
