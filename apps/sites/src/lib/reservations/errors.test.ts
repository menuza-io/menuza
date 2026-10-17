import { describe, expect, it } from 'vitest'
import { ReservationsApiError } from './api.ts'
import { invalidFieldPaths, reservationErrorKey } from './errors.ts'

describe('reservation errors', () => {
	it('maps API error codes to label keys', () => {
		const cases: Array<[number, string, string]> = [
			[409, 'slot_unavailable', 'errorSlotUnavailable'],
			[410, 'hold_expired', 'errorHoldExpired'],
			[429, 'rate_limited', 'errorRateLimited'],
			[403, 'verification_failed', 'errorVerification'],
			[503, 'unavailable', 'errorPaused'],
			[404, 'not_found', 'errorNotFound'],
			[409, 'phone_overlap', 'errorPhoneOverlap'],
			[409, 'cancel_closed', 'errorCancelClosed'],
			[400, 'invalid', 'errorInvalid'],
		]
		for (const [status, code, key] of cases) {
			expect(
				reservationErrorKey(new ReservationsApiError(status, code, {})),
			).toBe(key)
		}
	})

	it('falls back on the HTTP status, then to a generic or network message', () => {
		expect(reservationErrorKey(new ReservationsApiError(429, 'x', {}))).toBe(
			'errorRateLimited',
		)
		expect(reservationErrorKey(new ReservationsApiError(503, 'x', {}))).toBe(
			'errorPaused',
		)
		expect(reservationErrorKey(new ReservationsApiError(500, 'x', {}))).toBe(
			'errorGeneric',
		)
		expect(reservationErrorKey(new TypeError('Failed to fetch'))).toBe(
			'errorNetwork',
		)
	})

	it('reads flagged field paths and never values', () => {
		const error = new ReservationsApiError(400, 'invalid', {
			issues: [{ path: 'guest.phone', code: 'invalid' }, { nope: true }],
		})
		expect(invalidFieldPaths(error)).toEqual(['guest.phone'])
		expect(invalidFieldPaths(new Error('x'))).toEqual([])
	})
})
