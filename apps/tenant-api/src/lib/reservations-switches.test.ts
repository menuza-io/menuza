import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	isReservationsEmailEnabled,
	isReservationsSmsEnabled,
} from './reservations-switches.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

const CASES = [
	['RESERVATIONS_EMAIL_ENABLED', isReservationsEmailEnabled],
	['RESERVATIONS_SMS_ENABLED', isReservationsSmsEnabled],
] as const

describe.each(CASES)('%s kill switch', (name, isOn) => {
	it('is on when unset, empty or true', () => {
		vi.stubEnv(name, '')
		expect(isOn()).toBe(true)
		vi.stubEnv(name, 'true')
		expect(isOn()).toBe(true)
		vi.stubEnv(name, undefined)
		expect(isOn()).toBe(true)
	})

	it.each(['false', 'FALSE', '0', 'off', 'no', 'disabled'])(
		'is off for %s, and flips without a restart in both directions',
		(value) => {
			vi.stubEnv(name, 'true')
			expect(isOn()).toBe(true)
			vi.stubEnv(name, value)
			expect(isOn()).toBe(false)
			vi.stubEnv(name, 'true')
			expect(isOn()).toBe(true)
		},
	)

	it('turns back on when the variable is removed entirely', () => {
		vi.stubEnv(name, 'false')
		expect(isOn()).toBe(false)
		vi.stubEnv(name, undefined)
		expect(isOn()).toBe(true)
	})
})

describe('reservations switches', () => {
	it('keep email and SMS independent of each other', () => {
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'false')
		vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'true')
		expect(isReservationsEmailEnabled()).toBe(false)
		expect(isReservationsSmsEnabled()).toBe(true)
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'true')
		vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'false')
		expect(isReservationsEmailEnabled()).toBe(true)
		expect(isReservationsSmsEnabled()).toBe(false)
	})

	it('do not read the staffing or voice switches', () => {
		vi.stubEnv('STAFFING_EMAIL_ENABLED', 'false')
		expect(isReservationsEmailEnabled()).toBe(true)
		expect(isReservationsSmsEnabled()).toBe(true)
	})
})
