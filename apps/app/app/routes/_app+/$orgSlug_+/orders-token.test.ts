import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader } from './orders-token.ts'

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	client: vi.fn(),
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.organization,
}))
vi.mock('#app/utils/menu/access.server.ts', () => ({
	requireMenuRead: mocks.read,
	requireMenuWrite: mocks.write,
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))

describe('order credentials', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.organization.mockResolvedValue({ id: 'organization' })
		mocks.read.mockResolvedValue('operator')
		mocks.write.mockResolvedValue('operator')
		mocks.client.mockResolvedValue({
			jwt: 'scoped-credential',
			tenantApiUrl: 'https://regional.example',
			orgId: 'organization',
			fetchTenant: vi.fn(),
		})
	})

	async function run(suffix = '') {
		return loader({
			request: new Request(`https://app.example/cafe/orders-token${suffix}`),
			params: { orgSlug: 'cafe' },
			context: {} as never,
		} as unknown as Parameters<typeof loader>[0])
	}

	it('mints only read credentials after menu read authorization', async () => {
		const result = await run()
		expect(mocks.read).toHaveBeenCalled()
		expect(mocks.write).not.toHaveBeenCalled()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:read',
		})
		expect(result.data).toEqual({
			jwt: 'scoped-credential',
			tenantApiUrl: 'https://regional.example',
		})
	})

	it('requires menu mutation authorization before minting write credentials', async () => {
		await run('?write=1')
		expect(mocks.write).toHaveBeenCalled()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
		})
	})

	it('does not mint write credentials for a read-only operator', async () => {
		mocks.write.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(run('?write=1')).rejects.toMatchObject({ status: 403 })
		expect(mocks.client).not.toHaveBeenCalled()
	})
})
