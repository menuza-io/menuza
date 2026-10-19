import { afterEach, describe, expect, it } from 'vitest'
import {
	registerTenantDb,
	resolveTenantDb,
	setTenantDbResolver,
	unregisterTenantDb,
} from './resolver.ts'
import { type TenantDatabase } from './types.ts'

const dbA = { name: 'a' } as unknown as TenantDatabase
const dbB = { name: 'b' } as unknown as TenantDatabase
const never = async () => {
	throw new Error('fallback must not run')
}

describe('tenant DB registry', () => {
	afterEach(() => {
		unregisterTenantDb('org_a')
		unregisterTenantDb('org_b')
		setTenantDbResolver(null)
	})

	it('serves each org its own handle at the same time', async () => {
		registerTenantDb('org_a', dbA)
		registerTenantDb('org_b', dbB)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
		expect(await resolveTenantDb('org_b', {}, never)).toBe(dbB)
	})

	it('keeps a handle after the request-scoped resolver is cleared', async () => {
		registerTenantDb('org_a', dbA)
		setTenantDbResolver(async () => dbB)
		setTenantDbResolver(null)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
	})

	it('only unregisters the handle it owns', async () => {
		registerTenantDb('org_a', dbA)
		unregisterTenantDb('org_a', dbB)
		expect(await resolveTenantDb('org_a', {}, never)).toBe(dbA)
		unregisterTenantDb('org_a', dbA)
		expect(await resolveTenantDb('org_a', {}, async () => dbB)).toBe(dbB)
	})
})
