import { describe, expect, it } from 'vitest'
import { normalizeAllowedEmailDomains } from './sso-configuration.server.ts'

describe('normalizeAllowedEmailDomains', () => {
	it('lowercases, trims and de-duplicates', () => {
		expect(
			normalizeAllowedEmailDomains(' Acme.com, acme.co.uk ,ACME.com'),
		).toBe('acme.com,acme.co.uk')
	})

	it('refuses an empty or malformed list', () => {
		for (const value of ['', ' , ', 'acme', 'acme.com, not a domain', null]) {
			expect(normalizeAllowedEmailDomains(value)).toBeNull()
		}
	})
})
