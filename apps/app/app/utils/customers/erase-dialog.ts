/**
 * Pure rules for the "Erase this customer's data" dialog, kept apart from the
 * route so they can be tested.
 */

type ErasableCustomer = { name: string; phone: string | null }

/** What the operator may type to confirm: the name or the phone number. */
export function eraseConfirmationTargets(customer: ErasableCustomer) {
	return [customer.name, customer.phone].filter(
		(value): value is string =>
			typeof value === 'string' && value.trim() !== '',
	)
}

function digits(value: string) {
	return value.replace(/\D/g, '')
}

/**
 * The name (any case, surrounding space ignored) or the phone number (any
 * formatting: the digits must match). A customer with neither can only be
 * confirmed by typing "erase".
 */
export function matchesEraseConfirmation(
	customer: ErasableCustomer,
	typed: string,
) {
	const text = typed.trim()
	if (text === '') return false
	const targets = eraseConfirmationTargets(customer)
	if (targets.length === 0) return text.toLowerCase() === 'erase'
	const typedDigits = digits(text)
	return targets.some((target) => {
		if (target.trim().toLowerCase() === text.toLowerCase()) return true
		const targetDigits = digits(target)
		return (
			target === customer.phone &&
			targetDigits.length >= 7 &&
			typedDigits === targetDigits
		)
	})
}

export type EraseErrorKind =
	'permission' | 'recording' | 'unavailable' | 'network' | 'generic'

/** Maps the response to a kind; the server's text is never shown. */
export function classifyEraseError(
	status: number | null,
	code?: string | null,
): EraseErrorKind {
	if (status === null) return 'network'
	if (code === 'recording_delete_failed') return 'recording'
	if (status === 401 || status === 403) return 'permission'
	if (status >= 500) return 'unavailable'
	return 'generic'
}
