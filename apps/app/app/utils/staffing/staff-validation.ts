import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { normalizePhone, parseMoneyToMinor } from './staff-format.ts'

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

/**
 * The Positions page dialog. Every field is checked at once, so a bad rate is
 * flagged on the same Save as a missing name. `rate` is checked only when the
 * manager may set pay; an empty rate means "no default".
 */
export function validatePositionForm(
	values: { name: string; rate: string },
	translate: Translate,
	options: { canSetRate: boolean },
): Partial<Record<'name' | 'rate', string>> {
	const errors: Partial<Record<'name' | 'rate', string>> = {}
	if (!values.name.trim()) errors.name = translate(msg`Enter a name.`)
	if (
		options.canSetRate &&
		values.rate.trim() !== '' &&
		parseMoneyToMinor(values.rate) === null
	) {
		errors.rate = translate(msg`Enter an amount like 15.50.`)
	}
	return errors
}

/** "Add a position" on a person's Positions and pay tab. */
export function validateAddJobForm(
	values: { positionId: string; payType: 'hourly' | 'salary'; amount: string },
	translate: Translate,
	options: { canSetPay: boolean },
): Partial<Record<'positionId' | 'amount', string>> {
	const errors: Partial<Record<'positionId' | 'amount', string>> = {}
	if (!values.positionId) errors.positionId = translate(msg`Choose a position.`)
	if (!options.canSetPay) return errors
	if (values.amount.trim()) {
		if (parseMoneyToMinor(values.amount) === null) {
			errors.amount = translate(msg`Enter an amount like 15.50.`)
		}
	} else if (values.payType === 'salary') {
		errors.amount = translate(msg`Enter the yearly salary.`)
	}
	return errors
}

/** "Change rate" on a person's pay history. */
export function validateRateChangeForm(
	values: { amount: string; reason: string },
	translate: Translate,
): Partial<Record<'amount' | 'reason', string>> {
	const errors: Partial<Record<'amount' | 'reason', string>> = {}
	if (parseMoneyToMinor(values.amount) === null) {
		errors.amount = translate(msg`Enter an amount like 15.50.`)
	}
	if (!values.reason.trim()) {
		errors.reason = translate(msg`Add a reason for the change.`)
	}
	return errors
}
