import { afterEach, describe, expect, it } from 'vitest'
import { normalizeGuestPhone as normalizeGuestRowPhone } from '../services/rsv-guest-service.ts'
import { defaultPhoneRegion, isValidPhone, normalizePhone } from './phone.ts'

const original = process.env.DATA_REGION

afterEach(() => {
	process.env.DATA_REGION = original
})

describe('region-aware phone normalization in tenant-api', () => {
	it('reads Saudi local numbers as +966 on a ksa node', () => {
		process.env.DATA_REGION = 'ksa'
		expect(defaultPhoneRegion()).toBe('ksa')
		expect(normalizePhone('0501234567')).toBe('+966501234567')
		expect(isValidPhone(normalizePhone('05 0123 4567'))).toBe(true)
		expect(normalizeGuestRowPhone('0501234567')).toBe('+966501234567')
		expect(normalizeGuestRowPhone('(050) 123-4567')).toBe('+966501234567')
	})

	it('reads 10-digit numbers as +1 on a us node', () => {
		process.env.DATA_REGION = 'us'
		expect(defaultPhoneRegion()).toBe('us')
		expect(normalizePhone('(415) 555-2671')).toBe('+14155552671')
		expect(normalizeGuestRowPhone('4155552671')).toBe('+14155552671')
	})

	it('never changes E.164 input in any region', () => {
		for (const region of ['us', 'ksa']) {
			process.env.DATA_REGION = region
			expect(normalizePhone('+14155552671')).toBe('+14155552671')
			expect(normalizePhone('+966501234567')).toBe('+966501234567')
			expect(normalizeGuestRowPhone('+966501234567')).toBe('+966501234567')
			expect(normalizePhone('00966501234567')).toBe('+966501234567')
		}
	})

	it('falls back to us when DATA_REGION is not valid', () => {
		process.env.DATA_REGION = 'mars'
		expect(defaultPhoneRegion()).toBe('us')
	})
})
