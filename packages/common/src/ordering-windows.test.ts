import { describe, expect, it } from 'vitest'
import {
	intersectWindows,
	isCoveredBy,
	mergeWindows,
	overlaps,
	subtractWindows,
	windowMs,
} from './ordering-windows.ts'

const w = (from: number, to: number) => ({ from, to })

describe('ordering windows', () => {
	it('merges overlapping and touching windows and drops empty ones', () => {
		expect(mergeWindows([w(5, 9), w(1, 3), w(3, 4), w(8, 12), w(20, 20)])).toEqual([
			w(1, 4),
			w(5, 12),
		])
		expect(windowMs([w(0, 10), w(5, 15)])).toBe(15)
	})

	it('intersects and subtracts', () => {
		expect(intersectWindows([w(0, 10), w(20, 30)], [w(5, 25)])).toEqual([
			w(5, 10),
			w(20, 25),
		])
		expect(subtractWindows([w(0, 30)], [w(5, 10), w(20, 25)])).toEqual([
			w(0, 5),
			w(10, 20),
			w(25, 30),
		])
		expect(subtractWindows([w(0, 10)], [w(0, 10)])).toEqual([])
	})

	it('answers overlap and coverage', () => {
		expect(overlaps(w(5, 8), [w(0, 5), w(8, 9)])).toBe(false)
		expect(overlaps(w(5, 8), [w(7, 9)])).toBe(true)
		expect(isCoveredBy(w(2, 8), [w(0, 5), w(5, 10)])).toBe(true)
		expect(isCoveredBy(w(2, 12), [w(0, 10)])).toBe(false)
	})
})
