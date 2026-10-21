import { describe, expect, it } from 'vitest'
import { isValidPhone, normalizePhone } from '../lib/phone.ts'

describe('tenant-api shared phone normalization (@repo/reservations)', () => {
	it('normalizes and validates E.164 phone numbers consistently across auth and reservations', () => {
		expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671')
		expect(normalizePhone('00966 50 123 4567')).toBe('+966501234567')
		expect(isValidPhone(normalizePhone('+1 (415) 555-2671'))).toBe(true)
		expect(isValidPhone(normalizePhone('invalid'))).toBe(false)
	})
})
