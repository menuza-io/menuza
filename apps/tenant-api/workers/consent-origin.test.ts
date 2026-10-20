import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consentBaseUrl } from '../src/lib/email-consent.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

// The Durable Object modules need the Workers runtime and a generated
// migrations file; the fetch handler under test uses neither for /health.
vi.mock('./tenant-org.ts', () => ({
	TenantOrg: class {},
	TENANT_ORG_HEADER: 'x-tenant-org-id',
}))
vi.mock('./tenant-registry.ts', () => ({ TenantRegistry: class {} }))

const KEYS = ['NODE_ENV', 'TENANT_API_URL'] as const

describe('Worker without TENANT_API_URL', () => {
	const saved: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key]
		process.env.NODE_ENV = 'production'
		process.env.TENANT_API_URL = ''
	})

	afterEach(() => {
		for (const key of KEYS) process.env[key] = saved[key] ?? ''
	})

	it('still answers /health and does not throw on fetch', async () => {
		const { default: worker } = await import('./index.ts')
		const env = {
			DATA_REGION: 'us',
			NODE_ENV: 'production',
			JWT_SECRET: 'j'.repeat(40),
			AUTH_HMAC_SECRET: 'h'.repeat(40),
			INTERNAL_COMMAND_TOKEN: 'i'.repeat(40),
			TENANT_OPERATOR_TOKEN: 'o'.repeat(40),
		} as unknown as TenantApiWorkerEnv
		const res = await worker.fetch(
			new Request('https://tenant.example.com/health'),
			env,
			{} as ExecutionContext,
		)
		expect(res.status).toBe(200)
		// The per-send check still refuses to build a link.
		expect(consentBaseUrl()).toBeNull()
	})
})
