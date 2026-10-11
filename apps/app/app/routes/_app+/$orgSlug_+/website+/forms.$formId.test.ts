import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loader } from './forms.$formId.tsx'

const mocks = vi.hoisted(() => ({
	client: vi.fn(),
	permission: vi.fn(),
	organization: vi.fn(),
	fetchTenant: vi.fn(),
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: { UPDATE_WEBSITE_ANY: 'update:website:any' },
	requireUserWithOrganizationPermission: mocks.permission,
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.organization,
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	setCachedPublicForm: vi.fn(),
	deleteCachedPublicForm: vi.fn(),
}))

describe('form builder residency', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.client.mockResolvedValue({
			orgId: 'org-a',
			fetchTenant: mocks.fetchTenant,
		})
		mocks.permission.mockResolvedValue('operator')
		mocks.organization.mockResolvedValue({
			siteLocales: '["en","ar"]',
			siteDefaultLocale: 'en',
		})
	})

	function load() {
		return loader({
			request: new Request('https://app.example/cafe/website/forms/form-a'),
			params: { orgSlug: 'cafe', formId: 'form-a' },
			context: {} as never,
		} as unknown as Parameters<typeof loader>[0])
	}

	it('requests only the definition and count, never serializing submission values', async () => {
		mocks.fetchTenant.mockResolvedValue(
			Response.json({
				form: {
					id: 'form-a',
					name: 'Join our team',
					description: '',
					fields: [{ id: 'name', label: 'Name', type: 'name', required: true }],
					status: 'published',
					submitLabel: 'Apply',
					successMessage: 'Thanks',
				},
				submissions: [{ values: { name: 'Must not pass through App' } }],
				submissionCount: 1,
			}),
		)
		const result = await load()
		expect(mocks.fetchTenant).toHaveBeenCalledWith(
			'/operator/forms/form-a',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		expect(result).not.toHaveProperty('submissions')
		expect(result.submissionCount).toBe(1)
		expect(JSON.stringify(result)).not.toContain('Must not pass through App')
	})

	it('denies unauthorized definition reads before fetching', async () => {
		mocks.permission.mockRejectedValue(
			new Response('Forbidden', { status: 403 }),
		)
		await expect(load()).rejects.toMatchObject({ status: 403 })
		expect(mocks.fetchTenant).not.toHaveBeenCalled()
	})

	it('fails closed on a missing form or invalid regional response', async () => {
		mocks.fetchTenant.mockResolvedValueOnce(new Response(null, { status: 404 }))
		await expect(load()).rejects.toMatchObject({ status: 404 })
		mocks.fetchTenant.mockResolvedValueOnce(Response.json({ form: null }))
		await expect(load()).rejects.toMatchObject({ status: 502 })
	})
})
