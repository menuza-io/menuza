import { describe, expect, it } from 'vitest'
import { isValidNormalizedPhone, normalizeGuestPhone } from './phone.ts'

describe('normalizeGuestPhone and E.164 validation', () => {
	it('normalizes formatting characters and 00 prefixes to E.164', () => {
		expect(normalizeGuestPhone('+1 (415) 555-2671')).toBe('+14155552671')
		expect(normalizeGuestPhone('00966 50 123 4567')).toBe('+966501234567')
		expect(normalizeGuestPhone('+44.20.7946.0958')).toBe('+442079460958')
	})

	it('validates normalized E.164 numbers and rejects malformed phones', () => {
		expect(isValidNormalizedPhone('+14155552671')).toBe(true)
		expect(isValidNormalizedPhone('+966501234567')).toBe(true)
		expect(isValidNormalizedPhone('4155552671')).toBe(false)
		expect(isValidNormalizedPhone('+0123456789')).toBe(false)
		expect(isValidNormalizedPhone('+123')).toBe(false)
	})
})
