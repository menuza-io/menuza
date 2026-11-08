import { describe, expect, it, vi, beforeEach } from 'vitest'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { listOrganizationShopOrders } from '#app/utils/shop.server.ts'
import { loader } from './shop.tsx'

vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(),
}))

// An admin: orders are loaded only for people with read:settings:any.
vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requireUserId: vi.fn().mockResolvedValue('user-1'),
	userHasOrganizationPermission: vi.fn().mockResolvedValue(true),
}))

vi.mock('#app/utils/shop.server.ts', () => ({
	listOrganizationShopOrders: vi.fn(),
	listConfiguredShopProcessors: vi.fn(() => []),
	syncConnectAccountStatus: vi.fn(),
	syncCheckoutSubEntityStatus: vi.fn(),
}))

describe('settings+/shop loader', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('returns ordersUnavailable when tenant order lookup fails', async () => {
		const shopFields = expect.any(Object)
		vi.mocked(requireUserOrganization).mockResolvedValue({
			id: 'org-1',
			name: 'Acme',
			slug: 'acme',
			dataRegion: 'us',
			hasProvisionedDb: true,
		} as any)
		vi.mocked(listOrganizationShopOrders).mockRejectedValue(
			new Error('Database directory not found and createIfMissing is false.'),
		)

		const result = await loader({
			request: new Request('http://localhost:3001/acme/settings/shop'),
			params: { orgSlug: 'acme' },
			context: {},
		} as any)

		expect(requireUserOrganization).toHaveBeenCalledWith(
			expect.any(Request),
			'acme',
			shopFields,
		)
		expect(result.orders).toEqual([])
		expect(result.ordersUnavailable).toBe(true)
	})
})
