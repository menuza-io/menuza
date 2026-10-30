import { displayPhone, isValidPhone, normalizePhone } from './phone-number'

describe('phone numbers', () => {
	it('normalizes like tenant-api', () => {
		expect(normalizePhone('+1 (555) 000-1111')).toBe('+15550001111')
		expect(normalizePhone(' +966 50 000 0000 ')).toBe('+966500000000')
	})

	it('rejects numbers the SMS provider cannot use', () => {
		expect(isValidPhone('+15550001111')).toBe(true)
		expect(isValidPhone('+966 50 000 0000')).toBe(true)
		expect(isValidPhone('123')).toBe(false)
		expect(isValidPhone('+1555')).toBe(false)
		expect(isValidPhone('abcdefg')).toBe(false)
		expect(isValidPhone('+1555-ABC-1111')).toBe(false)
		expect(isValidPhone('+12345678901234567890')).toBe(false)
		// Arabic-Indic digits are numbers but not ASCII; the OTP path cannot process them.
		expect(isValidPhone('+٥٥٥٠٠٠١١١١')).toBe(false)
	})

	it('groups numbers for display', () => {
		expect(displayPhone('+15550001111')).toBe('+1 555 000 1111')
		expect(displayPhone('+966500000000')).toBe('+966 500 000 000')
		// No `+`: nothing to group, and the raw value is returned unchanged.
		expect(displayPhone('5550001111')).toBe('5550001111')
		expect(displayPhone('+999123456')).toBe('+999123456')
	})
})
