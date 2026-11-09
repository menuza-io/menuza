import { describe, expect, it } from 'vitest'
import { credentialRateLimitFor } from './credential-routes.ts'

describe('credentialRateLimitFor', () => {
	it.each([
		['POST', '/login'],
		['POST', '/login.data'],
		['POST', '/signup'],
		['POST', '/reset-password'],
		['POST', '/verify'],
		['POST', '/resources/verify'],
		['POST', '/api/auth/login'],
		['POST', '/api/auth/login/2fa'],
		['POST', '/api/auth/signup'],
		['PUT', '/login/'],
		['POST', '/LOGIN'],
		['POST', '/Login.data'],
		['POST', '/%6Cogin'],
		['POST', '/api/AUTH/login'],
		['POST', '//login'],
		['POST', '/webauthn/authentication'],
	])('throttles %s %s strictly', (method, path) => {
		expect(credentialRateLimitFor(method, path)?.maxRequests).toBe(10)
	})

	it('gives token refresh its own wider budget', () => {
		const limit = credentialRateLimitFor('POST', '/api/auth/refresh')
		expect(limit?.scope).toBe('worker-token-refresh')
		expect(limit?.maxRequests).toBeGreaterThan(10)
	})

	it.each([
		['GET', '/webauthn/authentication'],
		['HEAD', '/WebAuthn/Authentication'],
	])('limits the passkey challenge %s %s on its own budget', (method, path) => {
		expect(credentialRateLimitFor(method, path)?.scope).toBe(
			'worker-passkey-challenge',
		)
	})

	it.each([
		['GET', '/webauthn/registration'],
		['GET', '/login'],
		['HEAD', '/login'],
		['POST', '/login-help'],
		['POST', '/foo/login'],
		['POST', '/resources/verify-anything'],
		['POST', '/mcp/token'],
		['POST', '/api/notes'],
	])('does not throttle %s %s', (method, path) => {
		expect(credentialRateLimitFor(method, path)).toBeNull()
	})
})
