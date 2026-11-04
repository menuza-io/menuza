import { afterEach, describe, expect, it } from 'vitest'
import {
	defaultPhoneRegion,
	isValidPhone,
	legacyPhoneForms,
	normalizePhone,
} from './phone.ts'

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

describe('legacyPhoneForms', () => {
	it('finds the digits-only and national forms of the same US number', () => {
		expect(legacyPhoneForms('+15551234567', 'us').sort()).toEqual(
			['15551234567', '5551234567'].sort(),
		)
	})

	it('finds the digits-only and national forms of the same KSA number', () => {
		expect(legacyPhoneForms('+966501234567', 'ksa').sort()).toEqual(
			['966501234567', '0501234567', '501234567'].sort(),
		)
	})

	it('does not let a shorter E.164 claim a US national-form row', () => {
		// +5551234567 is a different (Brazilian) number than +1 555 123 4567.
		expect(legacyPhoneForms('+5551234567', 'us')).toEqual([])
	})

	it('does not let a shorter E.164 claim a KSA national-form row', () => {
		expect(legacyPhoneForms('+501234567', 'ksa')).toEqual([])
	})

	it('keeps the digits-only form for numbers that do not read as national', () => {
		expect(legacyPhoneForms('+442071234567', 'us')).toEqual(['442071234567'])
	})

	it('returns nothing for invalid input', () => {
		expect(legacyPhoneForms('not-a-phone', 'us')).toEqual([])
	})
})
