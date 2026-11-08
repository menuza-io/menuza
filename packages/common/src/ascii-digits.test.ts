import { describe, expect, it } from 'vitest'
import {
	isCompleteOtpCode,
	otpCodeDigits,
	toAsciiDigits,
} from './ascii-digits.ts'

describe('toAsciiDigits', () => {
	it('reads Arabic-Indic and Persian digits as ASCII', () => {
		expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
		expect(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
	})

	it('keeps every other character', () => {
		expect(toAsciiDigits('+٩٦٦ ٥٠ 123-4567')).toBe('+966 50 123-4567')
		expect(toAsciiDigits('abc')).toBe('abc')
		expect(toAsciiDigits('')).toBe('')
	})
})

describe('otpCodeDigits', () => {
	it('keeps the digits of a typed or pasted code', () => {
		expect(otpCodeDigits('١٢٣٤٥٦')).toBe('123456')
		expect(otpCodeDigits('۱۲۳۴۵۶')).toBe('123456')
		expect(otpCodeDigits('123 456')).toBe('123456')
		expect(otpCodeDigits(' 123-456 ')).toBe('123456')
		expect(otpCodeDigits('١٢٣ 456')).toBe('123456')
	})

	it('keeps at most six digits', () => {
		expect(otpCodeDigits('1234567')).toBe('123456')
		expect(otpCodeDigits('12a3')).toBe('123')
		expect(otpCodeDigits('code')).toBe('')
	})
})

describe('isCompleteOtpCode', () => {
	it('requires exactly six ASCII digits', () => {
		expect(isCompleteOtpCode('123456')).toBe(true)
		expect(isCompleteOtpCode('12345')).toBe(false)
		expect(isCompleteOtpCode('١٢٣٤٥٦')).toBe(false)
		expect(isCompleteOtpCode('123 456')).toBe(false)
	})
})
