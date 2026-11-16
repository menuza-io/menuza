import { i18n } from '@lingui/core'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeCampaignCoupon } from '#app/utils/discounts/marketing-offers.server.ts'
import { auditCampaign } from '#app/utils/marketing/campaign-audit.server.ts'
import { sendTestBroadcast } from '#app/utils/marketing/campaign-test-send.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { action, loader } from './campaigns.$campaignId.tsx'

vi.mock('#app/utils/marketing/campaign-audit.server.ts', () => ({
	auditCampaign: vi.fn(),
}))
vi.mock('#app/utils/marketing/campaign-test-send.server.ts', () => ({
	sendTestBroadcast: vi.fn(),
}))

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
			orgSlug: 'test-org',
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

// The page's and the list menu's actions (#101). tenant-api owns the rules; the
// App checks the permission, mints only the claims an action needs, maps the
// code to words, and audits with ids only.
describe('campaign actions', () => {
	let fetchTenant: ReturnType<typeof vi.fn>
	let client: ReturnType<typeof vi.spyOn>

	beforeAll(() => {
		i18n.load('en', {})
		i18n.activate('en')
	})

	beforeEach(() => {
		fetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission)
			.mockReset()
			.mockResolvedValue('user_1')
		vi.mocked(auditCampaign).mockReset().mockResolvedValue(undefined)
		vi.mocked(sendTestBroadcast).mockReset()
		client = vi.spyOn(tenantApiServer, 'getOperatorTenantClient')
		client.mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'test-org',
			dataRegion: 'us',
			jwt: undefined,
			tenantApiUrl: 'https://tenant.example.com',
			fetchTenant: fetchTenant as never,
		})
	})

	function call(fields: Record<string, string>) {
		const body = new FormData()
		for (const [key, value] of Object.entries(fields)) body.set(key, value)
		return action({
			request: new Request(
				'http://localhost:3001/test-org/marketing/campaigns/c1',
				{
					method: 'POST',
					body,
				},
			),
			params: { orgSlug: 'test-org', campaignId: 'c1' },
			context: {},
		} as never)
	}

	const redirectOf = (value: unknown) => {
		expect(value).toBeInstanceOf(Response)
		return (value as Response).headers.get('Location')
	}

	it('needs update:campaign:any before it does anything', async () => {
		vi.mocked(requireUserWithOrganizationPermission).mockRejectedValueOnce(
			new Response('Forbidden', { status: 403 }),
		)
		await expect(call({ intent: 'cancel' })).rejects.toMatchObject({
			status: 403,
		})
		expect(fetchTenant).not.toHaveBeenCalled()
		expect(auditCampaign).not.toHaveBeenCalled()
	})

	it('cancels and audits it, asking only for the update claim', async () => {
		fetchTenant.mockResolvedValueOnce(Response.json({ success: true }))
		const result = (await call({ intent: 'cancel' })) as {
			ok: boolean
			message: string
		}
		expect(result.ok).toBe(true)
		expect(fetchTenant).toHaveBeenCalledWith(
			'/operator/marketing/campaigns/c1/cancel',
			{ method: 'POST' },
		)
		expect(client).toHaveBeenCalledWith(expect.anything(), 'test-org', {
			canUpdate: true,
			canDelete: false,
		})
		expect(vi.mocked(auditCampaign).mock.calls[0]![0]).toMatchObject({
			kind: 'cancelled',
			campaignId: 'c1',
			organizationId: 'org_1',
			userId: 'user_1',
		})
	})

	it('mints the delete claim only for delete, then goes back to the list', async () => {
		fetchTenant.mockResolvedValueOnce(Response.json({ success: true }))
		const result = await call({ intent: 'delete' })
		expect(client).toHaveBeenCalledWith(expect.anything(), 'test-org', {
			canUpdate: true,
			canDelete: true,
		})
		expect(redirectOf(result)).toBe('/test-org/marketing/campaigns')
		expect(fetchTenant.mock.calls[0]![1]).toEqual({ method: 'DELETE' })
		expect(vi.mocked(auditCampaign).mock.calls[0]![0].kind).toBe('deleted')
	})

	it('duplicates into a new draft and opens it, auditing both ids', async () => {
		fetchTenant.mockResolvedValueOnce(Response.json({ campaignId: 'c-copy' }))
		const result = await call({ intent: 'duplicate' })
		expect(redirectOf(result)).toBe('/test-org/marketing/campaigns/c-copy')
		expect(vi.mocked(auditCampaign).mock.calls[0]![0]).toMatchObject({
			kind: 'duplicated',
			campaignId: 'c-copy',
			sourceCampaignId: 'c1',
		})
	})

	it('re-sends to non-openers into a draft opened for editing, with the new subject', async () => {
		fetchTenant.mockResolvedValueOnce(Response.json({ campaignId: 'c-resend' }))
		const result = await call({
			intent: 'retarget',
			subject: '  Last chance  ',
		})
		expect(redirectOf(result)).toBe(
			'/test-org/marketing/campaigns/c-resend/edit',
		)
		expect(JSON.parse(fetchTenant.mock.calls[0]![1].body)).toEqual({
			subject: 'Last chance',
		})
		expect(vi.mocked(auditCampaign).mock.calls[0]![0]).toMatchObject({
			kind: 'retargeted',
			campaignId: 'c-resend',
			sourceCampaignId: 'c1',
		})
	})

	it.each([
		['campaign_already_sending', 409, /already sending/i],
		['already_retargeted', 409, /already re-sent/i],
		['retarget_too_early', 409, /48 hours/],
		['campaign_not_deletable', 409, /draft or a cancelled/i],
	])('answers %s in words, and audits nothing', async (code, status, words) => {
		fetchTenant.mockResolvedValueOnce(
			Response.json({ error: code }, { status }),
		)
		const result = (await call({
			intent:
				code === 'already_retargeted' || code === 'retarget_too_early'
					? 'retarget'
					: code === 'campaign_not_deletable'
						? 'delete'
						: 'cancel',
		})) as { data: { ok: boolean; error: string }; init: { status: number } }
		expect(result.data.ok).toBe(false)
		expect(result.data.error).toMatch(words)
		expect(result.init.status).toBe(status)
		expect(auditCampaign).not.toHaveBeenCalled()
	})

	it('sends a test of the saved message and audits it only when it was sent', async () => {
		fetchTenant.mockImplementation(async () =>
			Response.json({
				campaign: {
					channel: 'email',
					subject: 'Hi',
					content: 'Hello',
					contentHtml: '<p>Hello</p>',
				},
			}),
		)
		vi.mocked(sendTestBroadcast).mockResolvedValueOnce({
			ok: true,
			message: 'sent',
		})
		expect(await call({ intent: 'test' })).toEqual({
			ok: true,
			message: 'sent',
		})
		expect(fetchTenant).toHaveBeenCalledWith(
			'/operator/marketing/campaigns/c1/message',
		)
		expect(vi.mocked(auditCampaign).mock.calls[0]![0].kind).toBe('test_sent')

		vi.mocked(auditCampaign).mockClear()
		vi.mocked(sendTestBroadcast).mockResolvedValueOnce({
			ok: false,
			message: 'limit',
		})
		const refused = (await call({ intent: 'test' })) as {
			data: { ok: boolean }
		}
		expect(refused.data.ok).toBe(false)
		expect(auditCampaign).not.toHaveBeenCalled()
	})

	it('refuses an intent it does not know', async () => {
		const result = (await call({ intent: 'burn' })) as {
			init: { status: number }
		}
		expect(result.init.status).toBe(400)
		expect(fetchTenant).not.toHaveBeenCalled()
	})
})
