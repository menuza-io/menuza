import {
	ApiError,
	regionUnavailableError,
	transportError,
	unauthorizedError,
} from '../api/api-error'
import { appErrorFrom } from './app-error'

describe('appErrorFrom', () => {
	it('words transport failures as a network error', () => {
		expect(
			appErrorFrom(
				transportError(new TypeError('Network request failed')),
				'sendCode',
			),
		).toEqual({
			reason: 'network',
		})
	})

	it('reads the codes the app and the servers send', () => {
		expect(appErrorFrom(regionUnavailableError(), 'site')).toEqual({
			reason: 'regionUnavailable',
		})
		expect(appErrorFrom(unauthorizedError(), 'profile')).toEqual({
			reason: 'signedOut',
		})
		expect(
			appErrorFrom(
				new ApiError(400, 'Enter a valid phone number.', 'invalid_phone'),
				'sendCode',
			),
		).toEqual({
			reason: 'invalidPhone',
		})
		expect(
			appErrorFrom(
				new ApiError(400, 'Name is required.', 'name_required'),
				'name',
			),
		).toEqual({
			reason: 'nameRequired',
		})
		expect(
			appErrorFrom(
				new ApiError(429, 'rate_limit_exceeded', 'rate_limit_exceeded'),
				'verify',
			),
		).toEqual({
			reason: 'rateLimited',
		})
	})

	it('reads a status in the context of the action', () => {
		expect(appErrorFrom(new ApiError(404, 'Not Found'), 'site')).toEqual({
			reason: 'siteNotFound',
		})
		expect(
			appErrorFrom(new ApiError(400, 'Invalid phone number'), 'sendCode'),
		).toEqual({
			reason: 'invalidPhone',
		})
		expect(
			appErrorFrom(new ApiError(400, 'Invalid or expired code'), 'verify'),
		).toEqual({
			reason: 'invalidCode',
		})
		expect(
			appErrorFrom(new ApiError(400, 'Invalid email address'), 'profile'),
		).toEqual({
			reason: 'invalidEmail',
		})
		expect(
			appErrorFrom(new ApiError(400, 'Name is too long'), 'profile'),
		).toEqual({
			reason: 'nameTooLong',
		})
		expect(
			appErrorFrom(new ApiError(429, 'Too many requests'), 'sendCode'),
		).toEqual({
			reason: 'rateLimited',
		})
		expect(
			appErrorFrom(new ApiError(500, 'Failed to send SMS'), 'sendCode'),
		).toEqual({
			reason: 'unavailable',
		})
	})

	it('keeps any other server message, which is all the server says', () => {
		expect(
			appErrorFrom(
				new ApiError(403, 'Organization is no longer active'),
				'verify',
			),
		).toEqual({
			reason: 'server',
			message: 'Organization is no longer active',
		})
	})

	it('never shows a decoding failure or an unknown error as server text', () => {
		expect(
			appErrorFrom(
				new ApiError(
					200,
					'Unexpected response from /auth/me',
					'unexpected_response',
				),
				'profile',
			),
		).toEqual({
			reason: 'generic',
		})
		expect(appErrorFrom(new Error('boom'), 'profile')).toEqual({
			reason: 'generic',
		})
		expect(appErrorFrom(new ApiError(418, '  '), 'profile')).toEqual({
			reason: 'generic',
		})
	})
})
