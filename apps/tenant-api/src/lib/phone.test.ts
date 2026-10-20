import { afterEach, describe, expect, it } from 'vitest'
import { defaultPhoneRegion, isValidPhone, normalizePhone } from './phone.ts'

const original = process.env.DATA_REGION

afterEach(() => {
	if (original === undefined) delete process.env.DATA_REGION
	else process.env.DATA_REGION = original
})

describe('tenant-api phone helpers', () => {
	it('reads national numbers in the node region', () => {
		process.env.DATA_REGION = 'ksa'
		expect(defaultPhoneRegion()).toBe('ksa')
		expect(normalizePhone('0501234567')).toBe('+966501234567')
		process.env.DATA_REGION = 'us'
		expect(normalizePhone('(555) 123-4567')).toBe('+15551234567')
	})

	it('defaults to us when DATA_REGION is missing or invalid', () => {
		process.env.DATA_REGION = 'mars'
		expect(defaultPhoneRegion()).toBe('us')
		expect(normalizePhone('5551234567')).toBe('+15551234567')
	})

	it('lets an explicit region win and keeps E.164 untouched', () => {
		process.env.DATA_REGION = 'us'
		expect(normalizePhone('0501234567', 'ksa')).toBe('+966501234567')
		expect(normalizePhone('+966501234567')).toBe('+966501234567')
		expect(isValidPhone('+966501234567')).toBe(true)
		expect(isValidPhone('0501234567')).toBe(false)
	})
})
