import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader } from './people-token.ts'

const mocks = vi.hoisted(() => ({ access: vi.fn(), client: vi.fn() }))
vi.mock('#app/utils/people/people-access.server.ts', () => ({
	requirePeopleAccess: mocks.access,
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))

const full = {
	customers: true,
	dining: 'full',
	canUpdateCustomers: true,
	canUpdateDining: true,
	canDelete: true,
}

async function run() {
	return loader({
		request: new Request('https://app.example/cafe/people-token'),
		params: { orgSlug: 'cafe' },
		context: {} as never,
	} as unknown as Parameters<typeof loader>[0])
}

describe('people credentials', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.client.mockResolvedValue({
			jwt: 'scoped-credential',
			tenantApiUrl: 'https://regional.example',
		})
	})

	it('signs one token with both facets, short-lived when it carries the guest read grant', async () => {
		mocks.access.mockResolvedValue({ access: full })
		const result = await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'people',
			canUpdate: true,
			canDelete: true,
			expiresIn: '5m',
			claims: {
				peopleCustomers: true,
				peopleDining: 'full',
				canUpdateGuest: true,
			},
		})
		expect(result.data).toMatchObject({
			jwt: 'scoped-credential',
			tenantApiUrl: 'https://regional.example',
			access: full,
		})
		expect(result.init?.headers).toMatchObject({
			'Cache-Control': 'private, no-store',
		})
	})

	it('claims nothing the member lacks', async () => {
		mocks.access.mockResolvedValue({
			access: {
				customers: true,
				dining: 'none',
				canUpdateCustomers: false,
				canUpdateDining: false,
				canDelete: false,
			},
		})
		await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'people',
			canUpdate: false,
			canDelete: false,
			expiresIn: '15m',
			claims: { peopleCustomers: true },
		})
	})

	it('mints nothing when access is refused', async () => {
		mocks.access.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(run()).rejects.toMatchObject({ status: 403 })
		expect(mocks.client).not.toHaveBeenCalled()
	})
})
