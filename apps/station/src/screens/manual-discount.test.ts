import { describe, expect, it } from 'vitest'
import { parseDecimal, readManualValue } from './ManualDiscount.tsx'

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

describe('readManualValue', () => {
	it('turns what was typed into cents or basis points', () => {
		expect(readManualValue('4', 'variable_amount')).toEqual({
			ok: true,
			amountMinor: 400,
		})
		expect(readManualValue('0.01', 'variable_amount')).toEqual({
			ok: true,
			amountMinor: 1,
		})
		expect(readManualValue('12,5', 'variable_percent')).toEqual({
			ok: true,
			percentBp: 1250,
		})
		expect(readManualValue('0.01', 'variable_percent')).toEqual({
			ok: true,
			percentBp: 1,
		})
	})

	it('refuses a value that rounds to nothing, before any PIN is asked for', () => {
		for (const raw of ['0', '0.004', '٠٫٠٠٤']) {
			expect(readManualValue(raw, 'variable_amount')).toEqual({
				ok: false,
				reason: 'value_required',
			})
			expect(readManualValue(raw, 'variable_percent')).toEqual({
				ok: false,
				reason: 'value_required',
			})
		}
	})

	it('refuses what is not a number, and more than 100 percent', () => {
		expect(readManualValue('ten', 'variable_amount')).toEqual({
			ok: false,
			reason: 'not_a_number',
		})
		expect(readManualValue('100.01', 'variable_percent')).toEqual({
			ok: false,
			reason: 'over_100',
		})
		expect(readManualValue('100', 'variable_percent')).toEqual({
			ok: true,
			percentBp: 10_000,
		})
	})
})
