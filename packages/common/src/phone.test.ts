import { describe, expect, it } from 'vitest'
import { isValidE164Phone, normalizePhone } from './phone.ts'

describe('normalizePhone', () => {
	it('reads Saudi national formats in the ksa region', () => {
		for (const raw of [
			'0501234567',
			'501234567',
			'966501234567',
			'050 123 4567',
			'(050) 123-4567',
		]) {
			expect(normalizePhone(raw, { region: 'ksa' })).toBe('+966501234567')
		}
	})

	it('reads US national formats in the us region', () => {
		for (const raw of [
			'5551234567',
			'15551234567',
			'(555) 123-4567',
			'555.123.4567',
		]) {
			expect(normalizePhone(raw, { region: 'us' })).toBe('+15551234567')
		}
	})

	it('never reinterprets input with a country code', () => {
		expect(normalizePhone('+15551234567', { region: 'ksa' })).toBe(
			'+15551234567',
		)
		expect(normalizePhone('+966501234567', { region: 'us' })).toBe(
			'+966501234567',
		)
		expect(normalizePhone('00966501234567', { region: 'us' })).toBe(
			'+966501234567',
		)
		expect(normalizePhone('0044 20 7123 4567', { region: 'ksa' })).toBe(
			'+442071234567',
		)
	})

	it('returns the cleaned input unchanged without a region or a rule', () => {
		expect(normalizePhone('0501234567')).toBe('0501234567')
		expect(normalizePhone('0501234567', { region: 'us' })).toBe('0501234567')
		expect(normalizePhone('12345', { region: 'ksa' })).toBe('12345')
		expect(normalizePhone('abc', { region: 'us' })).toBe('abc')
	})
})

describe('isValidE164Phone', () => {
	it('requires a plus and 7 to 15 digits', () => {
		expect(isValidE164Phone('+966501234567')).toBe(true)
		expect(isValidE164Phone('0501234567')).toBe(false)
		expect(isValidE164Phone('+0501234567')).toBe(false)
		expect(isValidE164Phone('+12345')).toBe(false)
	})
})
