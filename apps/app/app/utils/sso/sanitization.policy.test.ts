import { describe, expect, it } from 'vitest'
import { sanitizeSSOConfigInput } from './sanitization.server.ts'

describe('sanitizeSSOConfigInput keeps the access-policy fields', () => {
	it('preserves the verified-email flag, enforcement flag and domain allowlist', () => {
		const out = sanitizeSSOConfigInput({
			requireVerifiedEmail: true,
			enforceSSOLogin: true,
			allowedEmailDomains: 'Example.com, Company.ORG',
		})
		expect(out.requireVerifiedEmail).toBe(true)
		expect(out.enforceSSOLogin).toBe(true)
		expect(out.allowedEmailDomains).toBe('example.com,company.org')
	})

	it('lets an administrator clear the allowlist with null', () => {
		expect(sanitizeSSOConfigInput({ allowedEmailDomains: null })).toEqual({
			allowedEmailDomains: null,
		})
	})

	it('ignores values of the wrong type', () => {
		const out = sanitizeSSOConfigInput({
			requireVerifiedEmail: 'yes',
			enforceSSOLogin: 1,
			allowedEmailDomains: ['a.com'],
		})
		expect(out).toEqual({})
	})
})
