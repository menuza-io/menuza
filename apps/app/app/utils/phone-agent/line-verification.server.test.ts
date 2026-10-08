import { describe, expect, it } from 'vitest'
import {
	checkLineVerificationCode,
	generateLineVerificationCode,
	hashLineVerificationCode,
	LINE_VERIFICATION_CODE_PATTERN,
	LINE_VERIFICATION_MAX_ATTEMPTS,
	safeEqualHex,
} from './line-verification.server.ts'

const secret = 'test-secret'
const numberId = 'num_1'
const now = new Date('2025-01-01T12:00:00Z')

function stateFor(code: string, overrides: Partial<{ attempts: number }> = {}) {
	return {
		verificationCodeHash: hashLineVerificationCode(secret, numberId, code),
		verificationExpiresAt: new Date(now.getTime() + 60_000),
		verificationAttempts: overrides.attempts ?? 0,
	}
}

describe('line verification codes', () => {
	it('generates six-digit codes', () => {
		for (let index = 0; index < 50; index++) {
			expect(generateLineVerificationCode()).toMatch(
				LINE_VERIFICATION_CODE_PATTERN,
			)
		}
	})

	it('binds the hash to the number row', () => {
		expect(hashLineVerificationCode(secret, 'a', '123456')).not.toBe(
			hashLineVerificationCode(secret, 'b', '123456'),
		)
	})

	it('compares hex safely', () => {
		expect(safeEqualHex('abcd', 'abcd')).toBe(true)
		expect(safeEqualHex('abcd', 'abce')).toBe(false)
		expect(safeEqualHex('abcd', 'ab')).toBe(false)
		expect(safeEqualHex('', '')).toBe(false)
	})

	it('accepts the right code before expiry', () => {
		expect(
			checkLineVerificationCode(stateFor('123456'), {
				secret,
				numberId,
				code: '123456',
				now,
			}),
		).toEqual({ ok: true })
	})

	it('rejects a wrong code and counts down attempts', () => {
		expect(
			checkLineVerificationCode(stateFor('123456', { attempts: 1 }), {
				secret,
				numberId,
				code: '654321',
				now,
			}),
		).toEqual({
			ok: false,
			reason: 'mismatch',
			attemptsLeft: LINE_VERIFICATION_MAX_ATTEMPTS - 2,
		})
	})

	it('rejects expired codes', () => {
		const state = {
			...stateFor('123456'),
			verificationExpiresAt: new Date(now.getTime() - 1),
		}
		expect(
			checkLineVerificationCode(state, {
				secret,
				numberId,
				code: '123456',
				now,
			}),
		).toMatchObject({ ok: false, reason: 'expired' })
	})

	it('locks after the maximum attempts, even with the right code', () => {
		expect(
			checkLineVerificationCode(
				stateFor('123456', { attempts: LINE_VERIFICATION_MAX_ATTEMPTS }),
				{ secret, numberId, code: '123456', now },
			),
		).toMatchObject({ ok: false, reason: 'too_many_attempts' })
	})

	it('requires a code to have been sent', () => {
		expect(
			checkLineVerificationCode(
				{
					verificationCodeHash: null,
					verificationExpiresAt: null,
					verificationAttempts: 0,
				},
				{ secret, numberId, code: '123456', now },
			),
		).toMatchObject({ ok: false, reason: 'no_code' })
	})
})
