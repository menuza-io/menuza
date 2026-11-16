import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { action, loader } from './audiences._index.tsx'
import { activateTestLingui } from './test-lingui.ts'

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return { ...actual, requireUserWithOrganizationPermission: vi.fn() }
	},
)
vi.mock('#app/utils/marketing/marketing-flags.server.ts', () => ({
	getMarketingFeatures: vi.fn(),
}))

const features = (audiences: boolean) =>
	({
		audiences,
		orderAutomations: false,
		birthdays: false,
		cartReminders: false,
		aiDrafts: false,
	}) as Awaited<ReturnType<typeof getMarketingFeatures>>

const definition = {
	match: 'all',
	rules: [{ field: 'orders_count', op: 'gte', value: 1 }],
}

function post(fields: Record<string, string>) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	return new Request('http://localhost/acme/marketing/audiences', {
		method: 'POST',
		body: form,
	})
}

describe('Audiences route (#98)', () => {
	let fetchTenant: ReturnType<typeof vi.fn>
	const args = (request: Request) =>
		({ request, params: { orgSlug: 'acme' }, context: {} }) as never

	beforeEach(() => {
		activateTestLingui()
		fetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue('user_1')
		vi.mocked(getMarketingFeatures).mockResolvedValue(features(true))
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: 'org_1',
			orgSlug: 'acme',
			dataRegion: 'us',
			jwt: 'jwt',
			tenantApiUrl: 'http://localhost:3007',
			fetchTenant: fetchTenant as never,
		})
	})
	afterEach(() => vi.restoreAllMocks())

	it('the loader needs read:campaign and is a 404 while the flag is off', async () => {
		fetchTenant.mockResolvedValue(
			Response.json({ audiences: [{ id: 'a', name: 'Lapsed', version: 1, definition, counts: null }] }),
		)
		const result = (await loader(args(new Request('http://localhost/x')))) as {
			audiences: unknown[]
		}
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			'org_1',
			ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		)
		expect(result.audiences).toHaveLength(1)

		vi.mocked(getMarketingFeatures).mockResolvedValue(features(false))
		await expect(loader(args(new Request('http://localhost/x')))).rejects.toMatchObject({
			status: 404,
		})
	})

	it('the action needs update:campaign, is a 404 with the flag off, and refuses a bad definition without calling tenant-api', async () => {
		fetchTenant.mockResolvedValueOnce(Response.json({ audience: {} }, { status: 201 }))
		await action(args(post({ intent: 'save', name: 'A', definition: JSON.stringify(definition) })))
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			'org_1',
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		)
		fetchTenant.mockClear()
		const bad = (await action(
			args(
				post({
					intent: 'save',
					name: 'A',
					definition: JSON.stringify({
						match: 'all',
						rules: [{ field: 'allergy', value: 'nuts' }],
					}),
				}),
			),
		)) as { ok: boolean; error?: string }
		expect(bad.ok).toBe(false)
		expect(JSON.stringify(bad)).not.toContain('nuts')
		expect(fetchTenant).not.toHaveBeenCalled()

		vi.mocked(getMarketingFeatures).mockResolvedValue(features(false))
		await expect(
			action(args(post({ intent: 'save', name: 'A', definition: JSON.stringify(definition) }))),
		).rejects.toMatchObject({ status: 404 })
	})

	it('a preview returns counts only, and tenant-api errors become readable words', async () => {
		fetchTenant.mockResolvedValueOnce(
			Response.json({ counts: { size: 12, email: null, sms: null } }),
		)
		const preview = (await action(
			args(post({ intent: 'preview', definition: JSON.stringify(definition) })),
		)) as { ok: boolean; counts?: unknown }
		expect(preview).toEqual({
			ok: true,
			intent: 'preview',
			counts: { size: 12, email: null, sms: null },
		})
		expect(fetchTenant.mock.calls[0]![0]).toBe('/operator/marketing/audiences/preview')

		fetchTenant.mockResolvedValueOnce(
			Response.json({ error: 'audience_in_use' }, { status: 409 }),
		)
		const removed = (await action(
			args(post({ intent: 'delete', audienceId: 'a' })),
		)) as { ok: boolean; error?: string }
		expect(removed.ok).toBe(false)
		expect(removed.error).toMatch(/broadcast|automation/i)
	})
})
