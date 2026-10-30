import { LOYALTY_PERMISSIONS } from '@repo/loyalty'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader } from './orders-token.ts'

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	client: vi.fn(),
	link: vi.fn(),
	station: vi.fn(),
	locations: vi.fn(),
	grants: vi.fn(),
	impersonating: vi.fn(),
}))
vi.mock('@repo/auth', () => ({
	isImpersonating: mocks.impersonating,
}))
vi.mock('#app/utils/loyalty/access.server.ts', () => ({
	getUserLoyaltyGrants: mocks.grants,
	resolveLoyaltyLocationIds: mocks.locations,
}))
vi.mock('#app/utils/pos/station-apps.server.ts', () => ({
	getStationAppGrants: mocks.station,
}))
vi.mock('#app/utils/orders/customer-link.server.ts', () => ({
	getOrderCustomerLinkAccess: mocks.link,
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
		mocks.link.mockResolvedValue({ linkCustomers: false, linkGuests: false })
		mocks.station.mockResolvedValue({ timeclock: false, reservations: false })
		mocks.locations.mockResolvedValue(null)
		mocks.grants.mockResolvedValue([])
		mocks.impersonating.mockResolvedValue(false)
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
			claims: { locationIds: null },
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
			claims: { locationIds: null },
		})
	})

	it('does not mint write credentials for a read-only operator', async () => {
		mocks.write.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(run('?write=1')).rejects.toMatchObject({ status: 403 })
		expect(mocks.client).not.toHaveBeenCalled()
	})

	it('signs the person-link claims only when the member may open Customers', async () => {
		mocks.link.mockResolvedValue({ linkCustomers: true, linkGuests: false })
		await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:read',
			claims: { linkCustomers: true, linkGuests: false, locationIds: null },
		})
	})

	it('signs which Station apps the member may switch on, for write credentials only', async () => {
		mocks.station.mockResolvedValue({ timeclock: true, reservations: false })
		await run('?write=1')
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
			claims: {
				stationApps: { timeclock: true, reservations: false },
				locationIds: null,
			},
		})
		mocks.client.mockClear()
		await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:read',
			claims: { locationIds: null },
		})
	})

	it('signs the member’s locations on read and write credentials', async () => {
		mocks.locations.mockResolvedValue(['loc_1'])
		for (const suffix of ['', '?write=1']) {
			mocks.client.mockClear()
			await run(suffix)
			expect(mocks.locations).toHaveBeenCalledWith('operator', 'organization')
			expect(mocks.client).toHaveBeenCalledWith(
				expect.any(Request),
				'cafe',
				expect.objectContaining({
					claims: expect.objectContaining({ locationIds: ['loc_1'] }),
				}),
			)
		}
		mocks.locations.mockResolvedValue([])
		mocks.client.mockClear()
		await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:read',
			claims: { locationIds: [] },
		})
	})

	it('lets write credentials record loyalty refunds only for holders of the redemption grant', async () => {
		mocks.grants.mockResolvedValue([
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION,
		])
		await run('?write=1')
		expect(mocks.grants).toHaveBeenCalledWith('operator', 'organization')
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
			claims: { locationIds: null, refundLoyalty: true },
		})

		mocks.client.mockClear()
		await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:read',
			claims: { locationIds: null },
		})

		mocks.grants.mockResolvedValue([
			LOYALTY_PERMISSIONS.READ_LOYALTY,
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
		])
		mocks.client.mockClear()
		await run('?write=1')
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
			claims: { locationIds: null },
		})
	})

	it('marks impersonated credentials and never lets them record loyalty refunds', async () => {
		mocks.impersonating.mockResolvedValue(true)
		mocks.grants.mockResolvedValue([
			LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION,
		])
		await run('?write=1')
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
			claims: { locationIds: null, impersonated: true },
		})
	})
})
