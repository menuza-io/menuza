import { type I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { type AppError } from '../state/app-error'

/**
 * The customer-facing wording of an `AppError`. Only `server` passes text
 * through: what the server said when the app has no better wording for it.
 */
export function appErrorMessage(i18n: I18n, error: AppError): string {
	switch (error.reason) {
		case 'siteNotFound':
			return i18n._(
				msg`We couldn't find that site. Check the address and try again.`,
			)
		case 'regionUnavailable':
			return i18n._(msg`This site isn't available in this app yet.`)
		case 'invalidPhone':
			return i18n._(msg`Enter a valid phone number.`)
		case 'invalidCode':
			return i18n._(msg`That code isn't right or has expired. Try again.`)
		case 'nameRequired':
			return i18n._(msg`Enter your name.`)
		case 'nameTooLong':
			return i18n._(msg`That name is too long.`)
		case 'invalidEmail':
			return i18n._(msg`Enter a valid email address.`)
		case 'signedOut':
			return i18n._(msg`Your session ended. Please sign in again.`)
		case 'rateLimited':
			return i18n._(msg`Too many attempts. Please try again later.`)
		case 'network':
			return i18n._(msg`Network error. Please try again.`)
		case 'unavailable':
			return i18n._(
				msg`The service is unavailable right now. Please try again later.`,
			)
		case 'server':
			return error.message
		default:
			return i18n._(msg`Something went wrong. Please try again.`)
	}
}
