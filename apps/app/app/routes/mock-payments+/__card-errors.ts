import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * Card errors the hosted pages show, keyed by the code the emulator returns.
 * Unknown codes fall back to the generic decline text, so a query string or a
 * response never puts arbitrary text on the page.
 */
const MESSAGES: Record<string, MessageDescriptor> = {
	invalid_number: msg`Your card number is invalid.`,
	invalid_expiry: msg`Your card's expiration date is incomplete or in the past.`,
	invalid_cvc: msg`Your card's security code is incomplete.`,
	generic_decline: msg`Your card was declined.`,
	insufficient_funds: msg`Your card has insufficient funds.`,
	card_declined: msg`Your card was declined. Your request was in test mode, but used a non test card.`,
	authentication_failed: msg`We are unable to authenticate your payment method. Please choose a different payment method and try again.`,
	payment_intent_authentication_failure: msg`We are unable to authenticate your payment method. Please choose a different payment method and try again.`,
}

export function cardErrorDescriptor(code: string | null | undefined) {
	return MESSAGES[code ?? ''] ?? MESSAGES.generic_decline!
}

export const KNOWN_CARD_ERROR_CODES = Object.keys(MESSAGES)

export type CardFormAction =
	| {
			error: {
				kind: 'invalid' | 'declined' | 'inactive'
				code: string
				field?: 'number' | 'expiry' | 'cvc'
			}
	  }
	| undefined
