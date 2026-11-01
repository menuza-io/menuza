import { describe, expect, it } from 'vitest'
import { parseDecimal } from './ManualDiscount.tsx'

describe('parseDecimal', () => {
	it('reads Latin digits with a point or a comma', () => {
		expect(parseDecimal('10.5')).toBe(10.5)
		expect(parseDecimal('10,5')).toBe(10.5)
		expect(parseDecimal(' 7 ')).toBe(7)
	})

	it('reads Arabic-Indic digits and the Arabic decimal separator', () => {
		expect(parseDecimal('١٠')).toBe(10)
		expect(parseDecimal('١٠٫٥')).toBe(10.5)
		expect(parseDecimal('۱۲٫۲۵')).toBe(12.25)
	})

	it('ignores the Arabic thousands separator', () => {
		expect(parseDecimal('١٬٢٠٠٫٥')).toBe(1200.5)
	})

	it('refuses what is not a number', () => {
		expect(parseDecimal('')).toBeNull()
		expect(parseDecimal('abc')).toBeNull()
		expect(parseDecimal('1.2.3')).toBeNull()
	})
})
