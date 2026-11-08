import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}))
vi.mock('./migrations.generated.ts', () => ({ durableSqliteMigrations: {} }))

const findActiveOrganizationById = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findActiveOrganizationById,
}))
const deleteOrganizationRecordings = vi.hoisted(() =>
	vi.fn(async () => 'deleted' as const),
)
vi.mock('../src/lib/recording-storage.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	deleteOrganizationRecordings,
}))
vi.mock('../src/lib/secrets.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	applyVarlockEnv: () => {},
	assertTenantApiSecrets: () => {},
}))

import worker from './index.ts'

const TOKEN = 'internal-command-token-for-tests-1234'
const ORG = 'clw9x0a12000008l00test79'

const stub = { provision: vi.fn(), deprovision: vi.fn() }
const registry = { add: vi.fn(), remove: vi.fn(), list: vi.fn(async () => []) }
const env = {
	TENANT_API_RUNTIME: 'workers',
	INTERNAL_COMMAND_TOKEN: TOKEN,
	TENANT_ORG: { idFromName: (name: string) => name, get: () => stub },
	TENANT_REGISTRY: { idFromName: (name: string) => name, get: () => registry },
} as never
const ctx = { waitUntil: () => {} } as never

function command(path: '/api/provision' | '/api/deprovision') {
	return new Request(`https://tenant.example.test${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
		},
		// The caller claims the organization is in the US.
		body: JSON.stringify({ orgId: ORG, slug: 'acme', dataRegion: 'us' }),
	})
}

describe('Workers provisioning commands', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('trusts the App record over the region in the payload', async () => {
		findActiveOrganizationById.mockResolvedValue({
			id: ORG,
			slug: 'acme',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'ksa',
		})
		for (const path of ['/api/deprovision', '/api/provision'] as const) {
			const response = await worker.fetch(command(path), env, ctx)
			expect(response.status, path).toBe(409)
		}
		expect(stub.deprovision).not.toHaveBeenCalled()
		expect(stub.provision).not.toHaveBeenCalled()
		expect(deleteOrganizationRecordings).not.toHaveBeenCalled()
	})

	it('falls back to the payload when the App does not know the organization', async () => {
		findActiveOrganizationById.mockResolvedValue(null)
		const response = await worker.fetch(command('/api/deprovision'), env, ctx)
		expect(response.status).toBe(200)
		expect(stub.deprovision).toHaveBeenCalledOnce()
	})
})
