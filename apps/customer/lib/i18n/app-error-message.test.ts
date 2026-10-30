import { type AppError } from '../state/app-error'
import { appErrorMessage } from './app-error-message'
import { activateLocale, i18n } from './lingui'

beforeEach(() => {
	activateLocale('en')
})

describe('appErrorMessage', () => {
	it.each([
		[
			{ reason: 'siteNotFound' },
			"We couldn't find that site. Check the address and try again.",
		],
		[
			{ reason: 'regionUnavailable' },
			"This site isn't available in this app yet.",
		],
		[{ reason: 'invalidPhone' }, 'Enter a valid phone number.'],
		[
			{ reason: 'invalidCode' },
			"That code isn't right or has expired. Try again.",
		],
		[{ reason: 'nameRequired' }, 'Enter your name.'],
		[{ reason: 'nameTooLong' }, 'That name is too long.'],
		[{ reason: 'invalidEmail' }, 'Enter a valid email address.'],
		[{ reason: 'signedOut' }, 'Your session ended. Please sign in again.'],
		[{ reason: 'rateLimited' }, 'Too many attempts. Please try again later.'],
		[{ reason: 'network' }, 'Network error. Please try again.'],
		[
			{ reason: 'unavailable' },
			'The service is unavailable right now. Please try again later.',
		],
		[{ reason: 'generic' }, 'Something went wrong. Please try again.'],
	] as const)('maps %s', (error: AppError, expected: string) => {
		expect(appErrorMessage(i18n, error)).toBe(expected)
	})

	it('passes a server message through', () => {
		expect(
			appErrorMessage(i18n, { reason: 'server', message: 'Custom failure' }),
		).toBe('Custom failure')
	})
})
