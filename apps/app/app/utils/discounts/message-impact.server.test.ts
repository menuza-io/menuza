import { AuditAction } from '@repo/audit'
import { userHasOrganizationPermission } from '@repo/auth'
import { AuditLog, db } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { auditCampaign } from '#app/utils/marketing/campaign-audit.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import {
	cascadeOnPause,
	describePairedAutomations,
	endDateShortened,
	pairedAutomationIdsByDiscount,
	promiseChanged,
	readCascadeFlags,
	resumePairedAutomations,
} from './message-impact.server.ts'

vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<object>()),
	userHasOrganizationPermission: vi.fn(),
}))
vi.mock('#app/utils/marketing/campaign-audit.server.ts', () => ({
	auditCampaign: vi.fn(),
}))

const usedIn = {
	broadcasts: [
		{ id: 'b-scheduled', name: 'Friday', status: 'Scheduled', scheduledAt: 1 },
		{ id: 'b-sending', name: 'Now', status: 'Processing', scheduledAt: null },
	],
	automations: [
		{ id: 'a-1', name: 'Welcome' },
		{ id: 'a-2', name: 'Win back' },
	],
	issuedCodes: 3,
}

function form(fields: Record<string, string>) {
	const data = new FormData()
	for (const [key, value] of Object.entries(fields)) data.set(key, value)
	return data
}

describe('cascadeOnPause', () => {
	const fetchTenant = vi.fn()
	const input = (flags: Partial<ReturnType<typeof readCascadeFlags>>) => ({
		request: new Request('http://localhost/x'),
		organizationId: 'org_1',
		orgSlug: 'acme',
		userId: 'user_1',
		discountId: 'disc_a',
		flags: { pauseAutomations: false, cancelBroadcasts: false, ...flags },
	})
	const calls = () =>
		fetchTenant.mock.calls.map(
			([path, init]) => `${init?.method ?? 'GET'} ${path}`,
		)

	beforeEach(() => {
		fetchTenant
			.mockReset()
			.mockImplementation(async (path: string) =>
				path.startsWith('/operator/marketing/discount-used-in')
					? Response.json(usedIn)
					: Response.json({ success: true }),
			)
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'acme',
			dataRegion: 'us',
			jwt: undefined,
			tenantApiUrl: 'https://t.example',
			fetchTenant: fetchTenant as never,
		})
		vi.mocked(userHasOrganizationPermission).mockReset().mockResolvedValue(true)
		vi.mocked(auditCampaign).mockReset().mockResolvedValue(undefined)
	})

	it('does nothing, and asks the region nothing, when nothing was chosen', async () => {
		const result = await cascadeOnPause(input({}))
		expect(result).toEqual({
			pausedAutomationIds: [],
			cancelledCampaignIds: [],
			skipped: [],
			failed: 0,
		})
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it('pauses every automation the region says offers it, in one action', async () => {
		const result = await cascadeOnPause(input({ pauseAutomations: true }))
		expect(result.pausedAutomationIds).toEqual(['a-1', 'a-2'])
		expect(calls()).toEqual([
			'GET /operator/marketing/discount-used-in?discountId=disc_a',
			'POST /operator/journeys/a-1/pause',
			'POST /operator/journeys/a-2/pause',
		])
	})

	it('cancels only the scheduled broadcasts (a send in progress cannot be stopped) and audits each', async () => {
		const result = await cascadeOnPause(input({ cancelBroadcasts: true }))
		expect(result.cancelledCampaignIds).toEqual(['b-scheduled'])
		expect(calls()).toEqual([
			'GET /operator/marketing/discount-used-in?discountId=disc_a',
			'POST /operator/marketing/campaigns/b-scheduled/cancel',
		])
		expect(vi.mocked(auditCampaign).mock.calls[0]![0]).toMatchObject({
			kind: 'cancelled',
			campaignId: 'b-scheduled',
			organizationId: 'org_1',
		})
	})

	it('does both when asked, and reports counts only', async () => {
		const result = await cascadeOnPause(
			input({ pauseAutomations: true, cancelBroadcasts: true }),
		)
		expect(result.pausedAutomationIds).toHaveLength(2)
		expect(result.cancelledCampaignIds).toHaveLength(1)
		expect(result.failed).toBe(0)
	})

	it('a member who can edit discounts but not campaigns cannot pause or cancel them', async () => {
		vi.mocked(userHasOrganizationPermission).mockResolvedValue(false)
		const result = await cascadeOnPause(
			input({ pauseAutomations: true, cancelBroadcasts: true }),
		)
		expect(result.skipped).toEqual([
			'automations_forbidden',
			'broadcasts_forbidden',
		])
		expect(result.pausedAutomationIds).toEqual([])
		expect(result.cancelledCampaignIds).toEqual([])
		// Only the lookup went out: nothing was paused or cancelled.
		expect(calls()).toEqual([
			'GET /operator/marketing/discount-used-in?discountId=disc_a',
		])
		expect(auditCampaign).not.toHaveBeenCalled()
		const asked = vi
			.mocked(userHasOrganizationPermission)
			.mock.calls.map(([, , permission]) => permission)
		expect(asked).toEqual(['update:automation:any', 'update:campaign:any'])
	})

	it('can allow one kind and refuse the other', async () => {
		vi.mocked(userHasOrganizationPermission).mockImplementation(
			async (_user, _org, permission) => permission === 'update:automation:any',
		)
		const result = await cascadeOnPause(
			input({ pauseAutomations: true, cancelBroadcasts: true }),
		)
		expect(result.pausedAutomationIds).toHaveLength(2)
		expect(result.skipped).toEqual(['broadcasts_forbidden'])
	})

	it('counts a message that could not be changed, and carries on', async () => {
		fetchTenant.mockImplementation(async (path: string) => {
			if (path.startsWith('/operator/marketing/discount-used-in')) {
				return Response.json(usedIn)
			}
			return path.includes('/a-1/')
				? Response.json({ error: 'nope' }, { status: 500 })
				: Response.json({ success: true })
		})
		const result = await cascadeOnPause(input({ pauseAutomations: true }))
		expect(result.pausedAutomationIds).toEqual(['a-2'])
		expect(result.failed).toBe(1)
	})

	it('does not guess when the region cannot be reached', async () => {
		fetchTenant.mockRejectedValue(new Error('down'))
		const result = await cascadeOnPause(input({ pauseAutomations: true }))
		expect(result.skipped).toEqual(['unreachable'])
		expect(result.pausedAutomationIds).toEqual([])
	})

	it('ignores an answer that is not the contract', async () => {
		fetchTenant.mockImplementation(async () =>
			Response.json({ broadcasts: [{ id: 'x', recipients: ['a@b.test'] }] }),
		)
		const result = await cascadeOnPause(input({ pauseAutomations: true }))
		expect(result.skipped).toEqual(['unreachable'])
	})
})

describe('what was paused with a discount', () => {
	async function status(
		organizationId: string,
		discountId: string,
		status: string,
		extra: Record<string, unknown> = {},
		at = new Date(),
	) {
		await db.insert(AuditLog).values({
			organizationId,
			action: AuditAction.DISCOUNT_STATUS_CHANGED,
			details: `Discount ${status}`,
			resourceType: 'discount',
			resourceId: discountId,
			metadata: JSON.stringify({ status, ...extra }),
			createdAt: at,
		})
	}

	it('offers back what the latest pause took with it, and nothing once resumed', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const t = (minutes: number) => new Date(Date.now() - minutes * 60_000)
		await status(
			organization.id,
			'd1',
			'paused',
			{ pausedAutomationIds: ['a-1', 'a-2'] },
			t(10),
		)
		await status(organization.id, 'd2', 'paused', {}, t(10))
		await status(
			organization.id,
			'd3',
			'paused',
			{ pausedAutomationIds: ['a-9'] },
			t(30),
		)
		await status(organization.id, 'd3', 'active', {}, t(20))

		const paired = await pairedAutomationIdsByDiscount(organization.id, [
			'd1',
			'd2',
			'd3',
			'd4',
		])
		expect(paired.get('d1')).toEqual(['a-1', 'a-2'])
		// Paused with nothing paired, resumed since, or never touched: no offer.
		expect(paired.has('d2')).toBe(false)
		expect(paired.has('d3')).toBe(false)
		expect(paired.has('d4')).toBe(false)
	})

	it('reads ids the way the audit writer really stores them: an object keyed by position', async () => {
		// `sanitizeMetadata` walks arrays as objects, so a list is saved as
		// {"0": …, "1": …}. Without reading that shape the pairing never works.
		const { organization } = await setupTestOrgWithUser('admin')
		await status(organization.id, 'd1', 'paused', {
			pausedAutomationIds: { '0': 'a-1', '1': 'a-2' },
		})
		expect(
			(await pairedAutomationIdsByDiscount(organization.id, ['d1'])).get('d1'),
		).toEqual(['a-1', 'a-2'])
	})

	it('ignores ids that are not strings', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await status(organization.id, 'd1', 'paused', {
			pausedAutomationIds: ['a-1', 7, null, '', { nested: 'x' }],
		})
		expect(
			(await pairedAutomationIdsByDiscount(organization.id, ['d1'])).get('d1'),
		).toEqual(['a-1'])
	})

	it('uses a later pause, not an earlier one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const t = (minutes: number) => new Date(Date.now() - minutes * 60_000)
		await status(
			organization.id,
			'd1',
			'paused',
			{ pausedAutomationIds: ['old'] },
			t(60),
		)
		await status(organization.id, 'd1', 'active', {}, t(50))
		await status(
			organization.id,
			'd1',
			'paused',
			{ pausedAutomationIds: ['new'] },
			t(5),
		)
		expect(
			(await pairedAutomationIdsByDiscount(organization.id, ['d1'])).get('d1'),
		).toEqual(['new'])
	})

	it('never reads another organization’s history', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await status(a.organization.id, 'd1', 'paused', {
			pausedAutomationIds: ['a-1'],
		})
		expect(
			(await pairedAutomationIdsByDiscount(b.organization.id, ['d1'])).size,
		).toBe(0)
	})

	it('names only the paired automations that are still paused', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await status(organization.id, 'd1', 'paused', {
			pausedAutomationIds: ['a-paused', 'a-active', 'a-gone'],
		})
		const fetchTenant = vi.fn(async (path: string) => {
			if (path.endsWith('/a-paused')) {
				return Response.json({ journey: { name: 'Welcome', status: 'paused' } })
			}
			if (path.endsWith('/a-active')) {
				return Response.json({
					journey: { name: 'Edited since', status: 'active' },
				})
			}
			return Response.json({ error: 'not found' }, { status: 404 })
		})
		expect(
			await describePairedAutomations({
				fetchTenant,
				organizationId: organization.id,
				discountId: 'd1',
			}),
		).toEqual([{ id: 'a-paused', name: 'Welcome' }])
	})
})

describe('resumePairedAutomations', () => {
	const fetchTenant = vi.fn()
	const base = {
		request: new Request('http://localhost/x'),
		organizationId: 'org_1',
		orgSlug: 'acme',
		userId: 'user_1',
		automationIds: ['a-1', 'a-2', 'a-3'],
	}

	beforeEach(() => {
		fetchTenant
			.mockReset()
			.mockImplementation(async (path: string, init?: RequestInit) => {
				if (init?.method === 'POST') return Response.json({ success: true })
				// a-2 was changed by hand since: it is active again.
				return Response.json({
					journey: { status: path.endsWith('/a-2') ? 'active' : 'paused' },
				})
			})
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'acme',
			dataRegion: 'us',
			jwt: undefined,
			tenantApiUrl: 'https://t.example',
			fetchTenant: fetchTenant as never,
		})
		vi.mocked(userHasOrganizationPermission).mockReset().mockResolvedValue(true)
	})

	it('resumes only what is still paused, one publish each', async () => {
		const result = await resumePairedAutomations(base)
		expect(result.resumedAutomationIds).toEqual(['a-1', 'a-3'])
		const posts = fetchTenant.mock.calls
			.filter(([, init]) => init?.method === 'POST')
			.map(([path]) => path)
		expect(posts).toEqual([
			'/operator/journeys/a-1/publish',
			'/operator/journeys/a-3/publish',
		])
	})

	it('does not resume anything for a member who cannot change automations', async () => {
		vi.mocked(userHasOrganizationPermission).mockResolvedValue(false)
		const result = await resumePairedAutomations(base)
		expect(result).toEqual({
			resumedAutomationIds: [],
			failed: 0,
			forbidden: true,
		})
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it('does nothing when nothing was paired', async () => {
		const result = await resumePairedAutomations({ ...base, automationIds: [] })
		expect(result.resumedAutomationIds).toEqual([])
		expect(fetchTenant).not.toHaveBeenCalled()
	})
})

describe('promiseChanged', () => {
	const stored = {
		valueType: 'percent',
		percentBp: 1000,
		amountMinor: null,
		tiers: null,
		maxDiscountMinor: null,
		endsAt: '2027-01-31T23:59',
		status: 'active',
	}

	it('is false for an unchanged discount rebuilt with undefined where null was stored', () => {
		expect(
			promiseChanged(stored, {
				...stored,
				amountMinor: undefined,
				tiers: undefined,
			}),
		).toBe(false)
	})

	it('is false when only things that do not change the promise differ', () => {
		expect(
			promiseChanged(stored, {
				...stored,
				endsAt: '2027-06-01T23:59',
				status: 'paused',
			}),
		).toBe(false)
	})

	it('is true when the amount, the kind of value, a ladder or the cap changes', () => {
		expect(promiseChanged(stored, { ...stored, percentBp: 1500 })).toBe(true)
		expect(
			promiseChanged(stored, {
				...stored,
				valueType: 'fixed',
				amountMinor: 500,
			}),
		).toBe(true)
		expect(
			promiseChanged(stored, {
				...stored,
				tiers: [{ at: 1000, percentBp: 500 }],
			}),
		).toBe(true)
		expect(promiseChanged(stored, { ...stored, maxDiscountMinor: 300 })).toBe(
			true,
		)
	})
})

describe('flags and end dates', () => {
	it('reads the two choices from the form, exactly "1"', () => {
		expect(
			readCascadeFlags(form({ pauseAutomations: '1', cancelBroadcasts: '1' })),
		).toEqual({
			pauseAutomations: true,
			cancelBroadcasts: true,
		})
		expect(
			readCascadeFlags(
				form({ pauseAutomations: 'true', cancelBroadcasts: '0' }),
			),
		).toEqual({
			pauseAutomations: false,
			cancelBroadcasts: false,
		})
	})

	it('calls an end date moved earlier, or added, a shortening', () => {
		expect(endDateShortened('2026-12-31T23:59', '2026-12-01T23:59')).toBe(true)
		expect(endDateShortened(null, '2026-12-01T23:59')).toBe(true)
		expect(endDateShortened(undefined, '2026-12-01T23:59')).toBe(true)
		expect(endDateShortened('2026-12-01T23:59', '2026-12-31T23:59')).toBe(false)
		expect(endDateShortened('2026-12-01T23:59', '2026-12-01T23:59')).toBe(false)
		expect(endDateShortened('2026-12-01T23:59', null)).toBe(false)
	})
})
