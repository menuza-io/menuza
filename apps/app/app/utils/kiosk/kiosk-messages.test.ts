import { i18n } from '@lingui/core'
import { KIOSK_ERROR_CODES } from '@repo/staffing'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeKioskError } from './kiosk-messages.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('kiosk messages', () => {
	it('has a plain line for every code the server can send', () => {
		for (const code of KIOSK_ERROR_CODES) {
			const { message, kind } = describeKioskError(code, {
				retryAfterSeconds: 30,
			})
			const text = i18n._(message)
			expect(text.length).toBeGreaterThan(8)
			expect(text).not.toMatch(/[_]{1}|\b[0-9]{3}\b|undefined|error/i)
			expect(['retry', 'wait', 'manager', 'repair']).toContain(kind)
		}
	})

	it('falls back to a calm generic line for an unknown code', () => {
		const { message, kind } = describeKioskError('weird_new_code')
		expect(i18n._(message)).toBe('Something went wrong. Please try again.')
		expect(kind).toBe('retry')
	})

	it('puts the wait in seconds into the message and pauses the pad', () => {
		const wrong = describeKioskError('invalid_pin', { retryAfterSeconds: 60 })
		expect(wrong.kind).toBe('wait')
		expect(i18n._(wrong.message)).toContain('60 seconds')
		const free = describeKioskError('invalid_pin', { retryAfterSeconds: 0 })
		expect(free.kind).toBe('retry')
		expect(
			i18n._(
				describeKioskError('backoff', { retryAfterSeconds: 29.2 }).message,
			),
		).toContain('30 seconds')
	})

	it('tells people to pair again only when the tablet itself is gone', () => {
		for (const code of ['device_revoked', 'invalid_device']) {
			expect(describeKioskError(code).kind).toBe('repair')
		}
		// The kill switch is temporary: ask a manager, do not unpair.
		expect(describeKioskError('kiosk_disabled').kind).toBe('manager')
		expect(describeKioskError('already_clocked_in').kind).toBe('retry')
	})
})
