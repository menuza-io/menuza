import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeCampaignCoupon } from '#app/utils/discounts/marketing-offers.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { loader } from './campaigns.$campaignId.tsx'

vi.mock('#app/utils/organization/permissions.server.ts', async (original) => ({
	...(await original<object>()),
	requireUserWithOrganizationPermission: vi.fn(),
}))

vi.mock('#app/utils/discounts/marketing-offers.server.ts', () => ({
	describeCampaignCoupon: vi.fn(),
}))

const request = new Request(
	'http://localhost:3001/test-org/marketing/campaigns/c1',
)
const args = {
	request,
	params: { orgSlug: 'test-org', campaignId: 'c1' },
	context: {},
} as any

// The recipient list (guest names, emails, phones) is read by the browser
// (#70). The loader reads only the PII-free summary for the coupon.
describe('campaign detail loader', () => {
	let fetchTenant: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue('user_1')
		vi.mocked(describeCampaignCoupon).mockReset()
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'test-org',
			dataRegion: 'ksa',
			jwt: 'marketing-jwt',
			tenantApiUrl: 'https://tenant-ksa.example.com',
			fetchTenant: fetchTenant as any,
		})
	})

	it('reads the summary, describes the coupon and hands the browser a Marketing token', async () => {
		const offer = { mode: 'shared', discountId: 'd1', code: 'SAVE10' }
		fetchTenant.mockResolvedValueOnce(
			Response.json({
				campaign: { id: 'c1', name: 'Spring', discountOffer: offer },
			}),
		)
		const coupon = {
			mode: 'shared',
			discountName: '10% off',
			code: 'SAVE10',
		} as const
		vi.mocked(describeCampaignCoupon).mockResolvedValueOnce(coupon)

		const result = await loader(args)

		expect(tenantApiServer.getOperatorTenantClient).toHaveBeenCalledWith(
			request,
			'test-org',
			{ area: 'marketing' },
		)
		expect(fetchTenant).toHaveBeenCalledTimes(1)
		expect(fetchTenant).toHaveBeenCalledWith(
			'/operator/marketing/campaigns/c1/summary',
		)
		expect(describeCampaignCoupon).toHaveBeenCalledWith('org_1', offer, {
			userId: 'user_1',
		})
		expect(result).toEqual({
			jwt: 'marketing-jwt',
			tenantApiUrl: 'https://tenant-ksa.example.com',
			campaignId: 'c1',
			name: 'Spring',
			coupon,
		})
	})

	it('leaves not-found and outage states to the browser fetch', async () => {
		fetchTenant.mockResolvedValueOnce(
			Response.json({ error: 'Campaign not found' }, { status: 404 }),
		)
		expect(await loader(args)).toMatchObject({ name: null, coupon: null })

		fetchTenant.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
		expect(await loader(args)).toMatchObject({ name: null, coupon: null })
		expect(describeCampaignCoupon).not.toHaveBeenCalled()
	})
})
