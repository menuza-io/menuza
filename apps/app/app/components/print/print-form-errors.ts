import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { PRINT_MAX_COPIES } from '@repo/common/print-shop'

/**
 * Print shop form schemas (here and in `@repo/common/print-shop`) report
 * codes, not English: the forms translate them here. Anything else (a Zod
 * default) shows the fallback, never untranslated text.
 */
export const PRINT_FORM_ERROR_LABELS: Record<string, MessageDescriptor> = {
	recipient_name: msg`Enter who receives the parcel`,
	recipient_phone: msg`Enter a phone number for the carrier`,
	street: msg`Enter a street address`,
	city: msg`Enter a city`,
	state: msg`Choose a state`,
	postal_code: msg`Enter a 5-digit ZIP code`,
	copies_number: msg`Enter a number of copies`,
	copies_whole: msg`Enter a whole number of copies`,
	copies_min: msg`Enter 0 or more copies`,
	copies_max: msg`Order at most ${PRINT_MAX_COPIES} copies`,
	product: msg`Choose what to print`,
	size: msg`Choose a size`,
	name: msg`Enter a name`,
}

export const PRINT_FORM_ERROR_FALLBACK = msg`Check this field.`

export function printFormErrors(
	translate: (descriptor: MessageDescriptor) => string,
	errors: string[] | undefined,
): Array<{ message: string }> | undefined {
	return errors?.map((code) => ({
		message: translate(
			PRINT_FORM_ERROR_LABELS[code] ?? PRINT_FORM_ERROR_FALLBACK,
		),
	}))
}
