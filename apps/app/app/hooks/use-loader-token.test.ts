import { describe, expect, it } from 'vitest'
import { tokenExpired } from './use-loader-token.ts'

function jwtWith(claims: Record<string, unknown>) {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '')
	return `${encode({ alg: 'HS256' })}.${encode(claims)}.sig`
}

describe('tokenExpired', () => {
	const now = Date.UTC(2026, 10, 13, 12)
	const seconds = now / 1000

	it('is true once exp has passed or is within a minute', () => {
		expect(tokenExpired(jwtWith({ exp: seconds - 1 }), now)).toBe(true)
		expect(tokenExpired(jwtWith({ exp: seconds + 30 }), now)).toBe(true)
	})

	it('is false for a token with time left, so a refusal is not retried', () => {
		expect(tokenExpired(jwtWith({ exp: seconds + 600 }), now)).toBe(false)
	})

	it('is false for a token it cannot read', () => {
		expect(tokenExpired(undefined, now)).toBe(false)
		expect(tokenExpired('not-a-jwt', now)).toBe(false)
		expect(tokenExpired('a.%%%.c', now)).toBe(false)
		expect(tokenExpired(jwtWith({}), now)).toBe(false)
	})
})
