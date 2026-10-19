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

describe('region-aware normalization of numbers without a country code', () => {
	it('never changes input that already has a country code', () => {
		for (const region of ['us', 'ksa', undefined] as const) {
			expect(normalizeGuestPhone('+14155552671', { region })).toBe(
				'+14155552671',
			)
			expect(normalizeGuestPhone('+966501234567', { region })).toBe(
				'+966501234567',
			)
			expect(normalizeGuestPhone('00966 50 123 4567', { region })).toBe(
				'+966501234567',
			)
		}
	})

	it('reads Saudi local numbers in the ksa region', () => {
		const opts = { region: 'ksa' } as const
		expect(normalizeGuestPhone('0501234567', opts)).toBe('+966501234567')
		expect(normalizeGuestPhone('05 0123 4567', opts)).toBe('+966501234567')
		expect(normalizeGuestPhone('501234567', opts)).toBe('+966501234567')
		expect(normalizeGuestPhone('966501234567', opts)).toBe('+966501234567')
		expect(
			isValidNormalizedPhone(normalizeGuestPhone('0501234567', opts)),
		).toBe(true)
	})

	it('reads US numbers in the us region and never gives a ksa number +1', () => {
		const us = { region: 'us' } as const
		expect(normalizeGuestPhone('(415) 555-2671', us)).toBe('+14155552671')
		expect(normalizeGuestPhone('1 415 555 2671', us)).toBe('+14155552671')
		expect(normalizeGuestPhone('0501234567', us)).toBe('0501234567')
	})

	it('leaves unknown shapes and region-less input unchanged (and invalid)', () => {
		expect(normalizeGuestPhone('4155552671')).toBe('4155552671')
		expect(normalizeGuestPhone('12345', { region: 'ksa' })).toBe('12345')
		expect(isValidNormalizedPhone(normalizeGuestPhone('4155552671'))).toBe(
			false,
		)
	})
})
