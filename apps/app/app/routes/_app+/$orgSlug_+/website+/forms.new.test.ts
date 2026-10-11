import { beforeEach, describe, expect, it, vi } from 'vitest'

import { action } from './forms.new.tsx'

const mocks = vi.hoisted(() => ({
	client: vi.fn(),
	permission: vi.fn(),
	fetchTenant: vi.fn(),
	cache: vi.fn(),
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: { UPDATE_WEBSITE_ANY: 'update:website:any' },
	requireUserWithOrganizationPermission: mocks.permission,
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	setCachedPublicForm: mocks.cache,
}))

describe('new application form', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.client.mockResolvedValue({
			orgId: 'org-a',
			fetchTenant: mocks.fetchTenant,
		})
		mocks.permission.mockResolvedValue('operator')
		mocks.fetchTenant.mockImplementation(
			async (ignoredPath: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>
				return Response.json({ form: { id: 'form-a', ...body } })
			},
		)
	})

	function create(template = 'job-application') {
		return action({
			request: new Request('https://app.example/cafe/website/forms/new', {
				method: 'POST',
				body: new URLSearchParams({ name: 'Join our team', template }),
			}),
			params: { orgSlug: 'cafe' },
			context: {} as never,
		} as unknown as Parameters<typeof action>[0])
	}

	it('creates a draft with application-specific copy, without public caching', async () => {
		const result = await create()
		expect(mocks.permission).toHaveBeenCalledWith(
			expect.any(Request),
			'org-a',
			'update:website:any',
		)
		const [pathname, init] = mocks.fetchTenant.mock.calls[0]!
		expect(pathname).toBe('/operator/forms')
		expect(JSON.parse(init.body)).toMatchObject({
			name: 'Join our team',
			status: 'draft',
			submitLabel: 'Send application',
			fields: expect.arrayContaining([
				expect.objectContaining({ id: 'role', required: true }),
			]),
		})
		expect(result).toBeInstanceOf(Response)
		expect((result as Response).headers.get('Location')).toBe(
			'/cafe/website/forms/form-a',
		)
		expect(mocks.cache).not.toHaveBeenCalled()
	})

	it('preserves default copy for existing templates', async () => {
		await create('contact')
		expect(JSON.parse(mocks.fetchTenant.mock.calls[0]![1].body)).toMatchObject({
			submitLabel: 'Submit',
			successMessage: 'Thank you. Your response has been received.',
		})
	})

	it('does not create a form when permission is denied', async () => {
		mocks.permission.mockRejectedValue(
			new Response('Forbidden', { status: 403 }),
		)
		await expect(create()).rejects.toMatchObject({ status: 403 })
		expect(mocks.fetchTenant).not.toHaveBeenCalled()
	})

	it('rejects unknown templates without contacting the regional API', async () => {
		expect(await create('unknown')).toEqual({ error: 'Template not found.' })
		expect(mocks.fetchTenant).not.toHaveBeenCalled()
	})
})
