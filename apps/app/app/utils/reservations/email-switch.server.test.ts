import { afterEach, describe, expect, it, vi } from 'vitest'
import { isReservationsEmailEnabled } from './email-switch.server.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('RESERVATIONS_EMAIL_ENABLED', () => {
	it('is on when unset', () => {
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', '')
		expect(isReservationsEmailEnabled()).toBe(true)
	})

	it.each(['true', '1', 'on', 'yes'])('stays on for %s', (value) => {
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', value)
		expect(isReservationsEmailEnabled()).toBe(true)
	})

	it.each(['false', '0', 'off', 'no', 'disabled', ' FALSE '])(
		'turns off for %s',
		(value) => {
			vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', value)
			expect(isReservationsEmailEnabled()).toBe(false)
		},
	)
})
