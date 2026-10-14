import { afterEach, describe, expect, it, vi } from 'vitest'
import { isEmailEnabled } from './email-switch.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('STAFFING_EMAIL_ENABLED kill switch', () => {
	it('is on when unset, empty or true', () => {
		vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
		expect(isEmailEnabled()).toBe(true)
		vi.stubEnv('STAFFING_EMAIL_ENABLED', 'true')
		expect(isEmailEnabled()).toBe(true)
	})

	it.each(['false', 'FALSE', '0', 'off', 'no', 'disabled'])(
		'is off for %s, and takes effect without a restart',
		(value) => {
			vi.stubEnv('STAFFING_EMAIL_ENABLED', 'true')
			expect(isEmailEnabled()).toBe(true)
			vi.stubEnv('STAFFING_EMAIL_ENABLED', value)
			expect(isEmailEnabled()).toBe(false)
		},
	)
})
