import { describe, expect, it } from 'vitest'
import {
	asciiNumberText,
	currencyExponent,
	minorToMajorText,
	parseMoneyToMinor,
	parseWholeNumber,
} from './money-input.ts'

describe('currencyExponent', () => {
	it('uses the decimals the currency really has', () => {
		expect(currencyExponent('SAR')).toBe(2)
		expect(currencyExponent('USD')).toBe(2)
		expect(currencyExponent('usd')).toBe(2)
		expect(currencyExponent('KWD')).toBe(3)
		expect(currencyExponent('JPY')).toBe(0)
	})

	it('counts a missing or malformed code as two decimals', () => {
		expect(currencyExponent(undefined)).toBe(2)
		expect(currencyExponent('')).toBe(2)
		expect(currencyExponent('not a code')).toBe(2)
	})
})

describe('parseMoneyToMinor with a currency', () => {
	it('reads SAR and USD in hundredths', () => {
		for (const currency of ['SAR', 'USD']) {
			expect(parseMoneyToMinor('4.5', { currency })).toBe(450)
			expect(parseMoneyToMinor('12', { currency })).toBe(1200)
			expect(parseMoneyToMinor('1.234', { currency })).toBeNull()
		}
	})

	it('reads KWD in thousandths', () => {
		const currency = 'KWD'
		expect(parseMoneyToMinor('1.5', { currency })).toBe(1500)
		expect(parseMoneyToMinor('1.234', { currency })).toBe(1234)
		expect(parseMoneyToMinor('12', { currency })).toBe(12000)
		expect(parseMoneyToMinor('١٫٢٣٤', { currency })).toBe(1234)
		expect(parseMoneyToMinor('1.2345', { currency })).toBeNull()
		expect(parseMoneyToMinor('0.001', { currency, min: 1 })).toBe(1)
	})

	it('reads JPY as whole yen and refuses decimals', () => {
		const currency = 'JPY'
		expect(parseMoneyToMinor('450', { currency })).toBe(450)
		expect(parseMoneyToMinor('1,500', { currency })).toBe(1500)
		expect(parseMoneyToMinor('4.5', { currency })).toBeNull()
		expect(parseMoneyToMinor('0', { currency, min: 1 })).toBeNull()
	})
})

describe('minorToMajorText', () => {
	it('writes minor units with the currency decimals', () => {
		expect(minorToMajorText(1550, 'USD')).toBe('15.50')
		expect(minorToMajorText(1550, 'SAR')).toBe('15.50')
		expect(minorToMajorText(1550, 'KWD')).toBe('1.550')
		expect(minorToMajorText(1550, 'JPY')).toBe('1550')
		expect(minorToMajorText(1550)).toBe('15.50')
	})
})

describe('parseMoneyToMinor', () => {
	it('reads whole units with up to two decimals', () => {
		expect(parseMoneyToMinor('4.5')).toBe(450)
		expect(parseMoneyToMinor(' 1,204.99 ')).toBe(120499)
		expect(parseMoneyToMinor('12')).toBe(1200)
		expect(parseMoneyToMinor('0.29')).toBe(29)
		expect(parseMoneyToMinor('1,234,567.89')).toBe(123456789)
		expect(parseMoneyToMinor('999,999,999.99')).toBe(99999999999)
	})

	it('refuses anything that is not an amount', () => {
		for (const input of ['', '-1', '1.234', 'abc', '1e3', '.5', '5.', '+5']) {
			expect(parseMoneyToMinor(input)).toBeNull()
		}
	})

	it('reads a comma only as a thousands separator, never as a decimal mark', () => {
		// Stripping every comma read "4,50" as 450.00, a hundred times the amount.
		for (const input of [
			'4,50',
			'12,50',
			'1,5',
			'1,2345',
			'0,500',
			'1,000,00',
			'1,000.000',
			',500',
			'1,',
			'1 000',
		]) {
			expect(parseMoneyToMinor(input)).toBeNull()
		}
		expect(parseMoneyToMinor('1,500')).toBe(150000)
		expect(parseMoneyToMinor('12,500.25')).toBe(1250025)
	})

	it('reads Arabic-Indic and Persian digits and the Arabic marks', () => {
		expect(parseMoneyToMinor('٤٫٥٠')).toBe(450)
		expect(parseMoneyToMinor('١٢')).toBe(1200)
		expect(parseMoneyToMinor('١٬٢٥٠٫٧٥')).toBe(125075)
		expect(parseMoneyToMinor('۱۵.۵')).toBe(1550)
		expect(parseMoneyToMinor('٤,٥٠')).toBeNull()
	})

	it('ignores the direction marks a copied Arabic number carries', () => {
		expect(parseMoneyToMinor('\u200f١٢٫٥٠\u200e')).toBe(1250)
		expect(parseMoneyToMinor('\u061c12.50')).toBe(1250)
		expect(parseMoneyToMinor(' \u200e4.5\u200f ')).toBe(450)
		expect(parseMoneyToMinor('\u200e\u200f')).toBeNull()
	})

	it('keeps to the bounds it is given', () => {
		expect(parseMoneyToMinor('0')).toBe(0)
		expect(parseMoneyToMinor('0', { min: 1 })).toBeNull()
		expect(parseMoneyToMinor('0.00', { min: 1 })).toBeNull()
		expect(parseMoneyToMinor('0.01', { min: 1 })).toBe(1)
		expect(parseMoneyToMinor('1,000,000', { max: 100_000_000 })).toBe(
			100_000_000,
		)
		expect(parseMoneyToMinor('1,000,000.01', { max: 100_000_000 })).toBeNull()
		expect(parseMoneyToMinor('1,000,000,000')).toBeNull()
	})
})

describe('parseWholeNumber', () => {
	it('reads digits in any of the scripts, grouped or not', () => {
		expect(parseWholeNumber('12')).toBe(12)
		expect(parseWholeNumber('10,000')).toBe(10000)
		expect(parseWholeNumber('١٢٣')).toBe(123)
		for (const input of ['', '1.5', '1,00', '-3', '1e3', 'ten']) {
			expect(parseWholeNumber(input)).toBeNull()
		}
	})

	it('ignores the direction marks a copied Arabic number carries', () => {
		expect(parseWholeNumber('\u200f١٢٣\u200e')).toBe(123)
		expect(parseWholeNumber('\u061c1,000')).toBe(1000)
	})

	it('keeps to the bounds it is given', () => {
		expect(parseWholeNumber('0', { min: 1 })).toBeNull()
		expect(parseWholeNumber('100,000', { min: 1, max: 100_000 })).toBe(100000)
		expect(parseWholeNumber('100,001', { min: 1, max: 100_000 })).toBeNull()
	})
})

describe('asciiNumberText', () => {
	it('maps the digits and marks and trims', () => {
		expect(asciiNumberText(' ١٬٢٣٤٫٥٦ ')).toBe('1,234.56')
		expect(asciiNumberText('۰۹')).toBe('09')
		expect(asciiNumberText('\u200f ١٢\u061c ')).toBe('12')
	})
})
