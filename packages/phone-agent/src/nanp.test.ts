import { describe, expect, it } from 'vitest'
import { isUsOrCanadaNumber } from './nanp.ts'

describe('isUsOrCanadaNumber', () => {
	it('accepts US, Canadian, and US territory numbers', () => {
		expect(isUsOrCanadaNumber('+12025550123')).toBe(true)
		expect(isUsOrCanadaNumber('+14165550123')).toBe(true)
		expect(isUsOrCanadaNumber('+17875550123')).toBe(true)
	})

	it('rejects Caribbean NANP countries and premium codes', () => {
		expect(isUsOrCanadaNumber('+18765550123')).toBe(false)
		expect(isUsOrCanadaNumber('+12425550123')).toBe(false)
		expect(isUsOrCanadaNumber('+18095550123')).toBe(false)
		expect(isUsOrCanadaNumber('+19005550123')).toBe(false)
	})

	it('rejects malformed and non-NANP numbers', () => {
		expect(isUsOrCanadaNumber('+442071234567')).toBe(false)
		expect(isUsOrCanadaNumber('+19115550123')).toBe(false)
		expect(isUsOrCanadaNumber('+12021550123')).toBe(false)
		expect(isUsOrCanadaNumber('2025550123')).toBe(false)
	})
})
