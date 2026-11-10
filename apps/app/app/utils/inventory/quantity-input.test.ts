import {
	formatQuantityText,
	parseQuantityText,
	stepQuantity,
} from '@repo/ui/quantity-input'
import { describe, expect, it } from 'vitest'

describe('parseQuantityText', () => {
	it('reads plain and decimal numbers', () => {
		expect(parseQuantityText('2')).toBe(2)
		expect(parseQuantityText(' 2.5 ')).toBe(2.5)
		expect(parseQuantityText('.5')).toBe(0.5)
		expect(parseQuantityText('1,250.5')).toBe(1250.5)
		expect(parseQuantityText('0.0005')).toBe(0.001)
	})

	it('reads Arabic-Indic and Persian digits and the Arabic decimal mark', () => {
		expect(parseQuantityText('٢')).toBe(2)
		expect(parseQuantityText('٢٫٥')).toBe(2.5)
		expect(parseQuantityText('۱۲')).toBe(12)
		expect(parseQuantityText('‏٣‏')).toBe(3)
		expect(parseQuantityText('١٬٢٥٠')).toBe(1250)
	})

	it('reads fractions', () => {
		expect(parseQuantityText('½')).toBe(0.5)
		expect(parseQuantityText('1½')).toBe(1.5)
		expect(parseQuantityText('2 ¾')).toBe(2.75)
		expect(parseQuantityText('1/2')).toBe(0.5)
		expect(parseQuantityText('1 1/4')).toBe(1.25)
		expect(parseQuantityText('3/4')).toBe(0.75)
	})

	it('refuses what it cannot read, rather than guess', () => {
		for (const bad of [
			'',
			'abc',
			'1,5',
			'1.2.3',
			'-2',
			'1/0',
			'2.5½',
			'1e3',
			'1 000',
		]) {
			expect([bad, parseQuantityText(bad)]).toEqual([bad, null])
		}
		expect(parseQuantityText('9999999999')).toBeNull()
	})
})

describe('formatQuantityText and stepQuantity', () => {
	it('shows a plain number', () => {
		expect(formatQuantityText(2)).toBe('2')
		expect(formatQuantityText(2.5)).toBe('2.5')
		expect(formatQuantityText(0.1 + 0.2)).toBe('0.3')
		expect(formatQuantityText(null)).toBe('')
	})

	it('steps without float drift and within bounds', () => {
		expect(stepQuantity(0.1, 0.2)).toBe(0.3)
		expect(stepQuantity(null, 1)).toBe(1)
		expect(stepQuantity(0.5, -1)).toBe(0)
		expect(stepQuantity(9, 5, { max: 10 })).toBe(10)
	})
})
