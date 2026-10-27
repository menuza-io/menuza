import { describe, expect, it } from 'vitest'
import { exceedsDrift, retailCents } from './pricing.ts'

describe('print pricing', () => {
	it('marks up and rounds up to a cent', () => {
		expect(retailCents(1000, 3000)).toBe(1300)
		expect(retailCents(999, 3000)).toBe(1299)
		expect(retailCents(1, 3000)).toBe(2)
		expect(retailCents(0, 3000)).toBe(0)
		expect(() => retailCents(-1, 3000)).toThrow()
		expect(() => retailCents(10.5, 3000)).toThrow()
	})

	it('holds a paid order when wholesale rose past the drift limit', () => {
		expect(exceedsDrift(1000, 1100, 1000)).toBe(false)
		expect(exceedsDrift(1000, 1101, 1000)).toBe(true)
		expect(exceedsDrift(1000, 900, 1000)).toBe(false)
	})
})
