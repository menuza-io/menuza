import { ClockApiError, ClockNetworkError } from '@repo/staffing/clock-client'
import { describe, expect, it } from 'vitest'
import { worthSavingForLater } from './clock.ts'

describe('worthSavingForLater', () => {
	it('saves a punch when the server, or the App behind it, cannot judge it now', () => {
		for (const error of [
			new ClockApiError(503, 'service_unavailable'),
			new ClockApiError(503, 'time_zone_unavailable'),
			new ClockApiError(503, 'kiosk_disabled'),
			new ClockApiError(503, 'pos_disabled'),
			new ClockApiError(429, 'rate_limit_exceeded'),
			new ClockApiError(500, 'internal_error'),
		])
			expect(worthSavingForLater(error)).toBe(true)
	})

	it('never saves a refusal of the punch itself, or a PIN wait', () => {
		for (const error of [
			new ClockApiError(401, 'invalid_pin'),
			new ClockApiError(429, 'backoff'),
			new ClockApiError(423, 'person_locked'),
			new ClockApiError(409, 'already_clocked_in'),
			new ClockApiError(403, 'timeclock_not_enabled'),
			new ClockNetworkError(),
			new Error('boom'),
		])
			expect(worthSavingForLater(error)).toBe(false)
	})
})
