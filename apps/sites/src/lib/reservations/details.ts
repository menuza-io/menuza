import { type GuestDetails } from './types.ts'

export type DetailsField = 'firstName' | 'phone' | 'email'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isPlausibleEmail(value: string): boolean {
	return EMAIL.test(value.trim())
}

/** At least 7 digits, only phone punctuation. The server normalizes and has the last word. */
export function isPlausiblePhone(value: string): boolean {
	const trimmed = value.trim()
	if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false
	const digits = trimmed.replace(/\D/g, '')
	return digits.length >= 7 && digits.length <= 15
}

export type DetailsErrors = Partial<
	Record<DetailsField, 'required' | 'invalid'>
>

export function validateDetails(guest: GuestDetails): DetailsErrors {
	const errors: DetailsErrors = {}
	if (!guest.firstName.trim()) errors.firstName = 'required'
	if (!guest.phone.trim()) errors.phone = 'required'
	else if (!isPlausiblePhone(guest.phone)) errors.phone = 'invalid'
	if (guest.email.trim() && !EMAIL.test(guest.email.trim())) {
		errors.email = 'invalid'
	}
	return errors
}

/** Splits one display name ("Jane Q Doe") into first and last for prefill. */
export function splitName(name: string | null | undefined): {
	firstName: string
	lastName: string
} {
	const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
	return {
		firstName: parts[0] ?? '',
		lastName: parts.slice(1).join(' '),
	}
}

export type DetailsInput = {
	guest: GuestDetails
	occasionTagId: string | null
	requests: string
	dietaryNames: string[]
	dietaryNotes: string
	smsOptIn: boolean
	marketingEmail: boolean
	marketingSms: boolean
	locale: string
	honeypot: string
	turnstileToken: string | null
	termsVersion: string
}

/** The `bookSchema` / `requestSchema` body fields shared by hold bookings and requests. */
export function buildBookingFields(input: DetailsInput) {
	const dietary = [...input.dietaryNames, input.dietaryNotes.trim()]
		.filter(Boolean)
		.join(', ')
	return {
		guest: {
			firstName: input.guest.firstName.trim(),
			lastName: input.guest.lastName.trim(),
			phone: input.guest.phone.trim(),
			email: input.guest.email.trim() || null,
		},
		occasionTagId: input.occasionTagId || null,
		requests: input.requests.trim() || null,
		dietary: dietary || null,
		smsOptIn: input.smsOptIn,
		marketing:
			input.marketingEmail || input.marketingSms
				? {
						email: input.marketingEmail,
						sms: input.marketingSms,
						textVersion: input.termsVersion,
					}
				: null,
		locale: input.locale,
		website: input.honeypot,
		turnstileToken: input.turnstileToken,
	}
}
