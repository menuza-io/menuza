import { ApiError } from '../api/api-error'

/**
 * Why an action failed, for the screens to word in the customer's language.
 * Only `server` carries text: what the server said, in English, when the app
 * has no better wording for it.
 */
export type AppError =
	| {
			reason:
				| 'siteNotFound'
				| 'regionUnavailable'
				| 'invalidPhone'
				| 'invalidCode'
				| 'nameRequired'
				| 'nameTooLong'
				| 'invalidEmail'
				| 'signedOut'
				| 'rateLimited'
				| 'network'
				| 'unavailable'
				| 'generic'
	  }
	| { reason: 'server'; message: string }

export type AppErrorReason = AppError['reason']

/** What the customer was doing, which decides how a 400 or a 404 reads. */
export type AppAction = 'site' | 'sendCode' | 'verify' | 'name' | 'profile'

/** tenant-api's profile validation messages (`profileSchema` in routes/auth.ts). */
const PROFILE_MESSAGES: Readonly<
	Record<string, Exclude<AppErrorReason, 'server'>>
> = {
	'Name is required': 'nameRequired',
	'Name is too long': 'nameTooLong',
	'Invalid email address': 'invalidEmail',
}

function reasonOnly(reason: Exclude<AppErrorReason, 'server'>): AppError {
	return { reason }
}

export function appErrorFrom(error: unknown, action: AppAction): AppError {
	if (!(error instanceof ApiError)) return reasonOnly('generic')
	if (error.isTransportFailure) return reasonOnly('network')
	switch (error.code) {
		case 'region_unavailable':
			return reasonOnly('regionUnavailable')
		case 'not_bound':
			return reasonOnly('siteNotFound')
		case 'invalid_phone':
			return reasonOnly('invalidPhone')
		case 'name_required':
			return reasonOnly('nameRequired')
		case 'unauthorized':
		case 'session_expired':
			return reasonOnly('signedOut')
		case 'rate_limit_exceeded':
		case 'rate_limited':
			return reasonOnly('rateLimited')
		case 'unexpected_response':
			return reasonOnly('generic')
	}
	if (error.isRateLimited) return reasonOnly('rateLimited')
	if (error.status >= 500) return reasonOnly('unavailable')
	if (action === 'site' && error.isNotFound) return reasonOnly('siteNotFound')
	if (error.status === 400) {
		if (action === 'sendCode') return reasonOnly('invalidPhone')
		if (action === 'verify') return reasonOnly('invalidCode')
		const known = PROFILE_MESSAGES[error.message.trim()]
		if (known) return reasonOnly(known)
	}
	if (error.isUnauthorized) return reasonOnly('signedOut')
	const message = error.message.trim()
	return message ? { reason: 'server', message } : reasonOnly('generic')
}
