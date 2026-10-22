import { describe, expect, it } from 'vitest'
import { quickCashAmounts } from './cash.ts'

describe('quickCashAmounts', () => {
	it('offers round tenders above the amount due, nearest first', () => {
		expect(quickCashAmounts(1083)).toEqual([1100, 1500, 2000, 5000])
		expect(quickCashAmounts(1000)).toEqual([2000, 5000, 10000])
	})
	it('never offers an amount below what is due', () => {
		for (const due of [1, 99, 100, 4999, 12345]) {
			expect(quickCashAmounts(due).every((a) => a > due)).toBe(true)
		}
	})
})
