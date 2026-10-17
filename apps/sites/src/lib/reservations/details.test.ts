import { describe, expect, it } from 'vitest'
import {
	buildBookingFields,
	isPlausiblePhone,
	splitName,
	validateDetails,
} from './details.ts'

const guest = {
	firstName: 'Ada',
	lastName: 'Lovelace',
	phone: '+1 415 555 0123',
	email: 'ada@example.com',
}

describe('details form', () => {
	it('requires a first name and a plausible phone', () => {
		expect(validateDetails({ ...guest, firstName: ' ', phone: 'abc' })).toEqual(
			{
				firstName: 'required',
				phone: 'invalid',
			},
		)
		expect(validateDetails({ ...guest, phone: '' })).toEqual({
			phone: 'required',
		})
		expect(validateDetails(guest)).toEqual({})
	})

	it('treats email as optional but checks its shape', () => {
		expect(validateDetails({ ...guest, email: '' })).toEqual({})
		expect(validateDetails({ ...guest, email: 'nope' })).toEqual({
			email: 'invalid',
		})
	})

	it('judges phone numbers by digits', () => {
		expect(isPlausiblePhone('+966 55 123 4567')).toBe(true)
		expect(isPlausiblePhone('12345')).toBe(false)
		expect(isPlausiblePhone('555-CALL-NOW')).toBe(false)
	})

	it('splits a profile name for prefill', () => {
		expect(splitName('Ada King Lovelace')).toEqual({
			firstName: 'Ada',
			lastName: 'King Lovelace',
		})
		expect(splitName(null)).toEqual({ firstName: '', lastName: '' })
	})

	it('builds the booking body with the honeypot and marketing consent', () => {
		const fields = buildBookingFields({
			guest: { ...guest, email: ' ' },
			occasionTagId: '',
			requests: ' window ',
			dietaryNames: ['Vegan'],
			dietaryNotes: ' nuts ',
			smsOptIn: true,
			marketingEmail: true,
			marketingSms: false,
			locale: 'ar',
			honeypot: '',
			turnstileToken: null,
			termsVersion: '2026-10',
		})
		expect(fields).toMatchObject({
			guest: { firstName: 'Ada', email: null },
			occasionTagId: null,
			requests: 'window',
			dietary: 'Vegan, nuts',
			smsOptIn: true,
			marketing: { email: true, sms: false, textVersion: '2026-10' },
			locale: 'ar',
			website: '',
		})
	})

	it('omits marketing when neither channel is chosen', () => {
		const fields = buildBookingFields({
			guest,
			occasionTagId: 'o1',
			requests: '',
			dietaryNames: [],
			dietaryNotes: '',
			smsOptIn: false,
			marketingEmail: false,
			marketingSms: false,
			locale: 'en',
			honeypot: '',
			turnstileToken: 'tt',
			termsVersion: 'v',
		})
		expect(fields.marketing).toBeNull()
		expect(fields.occasionTagId).toBe('o1')
		expect(fields.turnstileToken).toBe('tt')
	})
})
