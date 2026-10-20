import { describe, expect, it } from 'vitest'
import {
	assertWhitelistedOrgId,
	DEMO_ORGS,
	resolveDemoOrg,
} from './seed-demo-people-guard.ts'

describe('seed-demo-people-orders guard', () => {
	it('accepts the demo org', () => {
		const org = resolveDemoOrg({ slug: 'acme-demo', nodeEnv: 'development' })
		expect(org.id).toBe('demoorgus00000000000000001')
		expect(() => assertWhitelistedOrgId(org.id)).not.toThrow()
	})

	it('refuses the owner organization by slug and by id', () => {
		expect(() => resolveDemoOrg({ slug: 'acme' })).toThrow(/Refusing/)
		expect(() => assertWhitelistedOrgId('oyt8w3ubogfow0ea69t0f929')).toThrow(
			/Refusing/,
		)
	})

	it('refuses missing and prototype-like slugs', () => {
		expect(() => resolveDemoOrg({ slug: undefined })).toThrow(/Refusing/)
		expect(() => resolveDemoOrg({ slug: 'constructor' })).toThrow(/Refusing/)
	})

	it('refuses production, even for the demo org', () => {
		expect(() =>
			resolveDemoOrg({ slug: 'acme-demo', nodeEnv: 'production' }),
		).toThrow(/production/)
	})

	it('whitelists only demo ids', () => {
		expect(Object.values(DEMO_ORGS).map((o) => o.id)).toEqual([
			'demoorgus00000000000000001',
		])
	})
})
