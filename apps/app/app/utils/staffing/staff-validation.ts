import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { normalizePhone } from './staff-format.ts'

type Translate = (descriptor: MessageDescriptor) => string

export type PersonValues = {
	firstName: string
	lastName: string
	email: string
	phone: string
}

export type PersonErrors = Partial<
	Record<keyof PersonValues | 'contact', string>
>

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Client-side checks for a person form, in plain language. The server checks
 * everything again; this only saves a round trip and points at the field.
 * `requireContact` is the "name plus phone or email" rule for new staff.
 */
export function validatePerson(
	values: PersonValues,
	translate: Translate,
	options: { dialCode?: '1' | '966' | null; requireContact?: boolean } = {},
): PersonErrors {
	const errors: PersonErrors = {}
	if (!values.firstName.trim()) {
		errors.firstName = translate(msg`Enter a first name.`)
	} else if (values.firstName.trim().length > 80) {
		errors.firstName = translate(msg`Use 80 characters or fewer.`)
	}
	if (!values.lastName.trim()) {
		errors.lastName = translate(msg`Enter a last name.`)
	} else if (values.lastName.trim().length > 80) {
		errors.lastName = translate(msg`Use 80 characters or fewer.`)
	}
	const email = values.email.trim()
	const phone = values.phone.trim()
	if (email && !EMAIL.test(email)) {
		errors.email = translate(msg`Enter a valid email address.`)
	}
	if (phone && !normalizePhone(phone, options.dialCode ?? null)) {
		errors.phone = translate(
			msg`Enter a full phone number with the country code, like +14155550123.`,
		)
	}
	if (options.requireContact && !email && !phone) {
		errors.contact = translate(msg`Add a phone number or an email.`)
	}
	return errors
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
	return Object.values(errors).some(Boolean)
}
