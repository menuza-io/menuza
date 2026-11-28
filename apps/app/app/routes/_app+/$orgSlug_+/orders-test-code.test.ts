import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './orders-test-code.ts'

const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	flag: vi.fn(),
	write: vi.fn(),
	locations: vi.fn(),
	client: vi.fn(),
	fetchTenant: vi.fn(),
}))
vi.mock('@repo/common/feature-flags', () => ({ getFeatureFlag: mocks.flag }))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: mocks.organization,
}))
vi.mock('#app/utils/menu/access.server.ts', () => ({
	requireMenuWrite: mocks.write,
}))
vi.mock('#app/utils/loyalty/access.server.ts', () => ({
	resolveLoyaltyLocationIds: mocks.locations,
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))
vi.mock('#app/utils/launch/launch.server.ts', () => ({
	orgSiteUrl: () => 'https://cafe.example.com/',
}))

function run(locationId: string | null = 'loc_1') {
	const form = new FormData()
	if (locationId) form.set('locationId', locationId)
	return action({
		request: new Request('https://app.example/cafe/orders-test-code', {
			method: 'POST',
			body: form,
		}),
		params: { orgSlug: 'cafe' },
		context: {} as never,
	} as unknown as Parameters<typeof action>[0])
}

describe('POST /:orgSlug/orders-test-code (#119)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.organization.mockResolvedValue({
			id: 'org_1',
			slug: 'cafe',
			customDomain: null,
		})
		mocks.flag.mockResolvedValue(true)
		mocks.write.mockResolvedValue('operator')
		mocks.locations.mockResolvedValue(null)
		mocks.fetchTenant.mockResolvedValue(
			Response.json(
				{ code: 'tc1.loc_1.nonce.1.mac', expiresAt: 123 },
				{ status: 201 },
			),
		)
		mocks.client.mockResolvedValue({ fetchTenant: mocks.fetchTenant })
	})

	it('is a 404 while launch.test_order is off, before any permission or region call', async () => {
		mocks.flag.mockResolvedValue(null)
		await expect(run()).rejects.toMatchObject({ init: { status: 404 } })
		expect(mocks.write).not.toHaveBeenCalled()
		expect(mocks.client).not.toHaveBeenCalled()
		mocks.flag.mockResolvedValue('true')
		await expect(run()).rejects.toMatchObject({ init: { status: 404 } })
	})

	it('needs the orders write permission', async () => {
		mocks.write.mockRejectedValue(new Response('Forbidden', { status: 403 }))
		await expect(run()).rejects.toMatchObject({ status: 403 })
		expect(mocks.client).not.toHaveBeenCalled()
	})

	it('asks the region with an orders write token and answers the website link with the code in the fragment', async () => {
		const result = await run('loc_1')
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'orders:write',
			claims: { locationIds: null },
		})
		expect(mocks.fetchTenant).toHaveBeenCalledWith(
			'/operator/orders/test-code',
			{
				method: 'POST',
				body: JSON.stringify({ locationId: 'loc_1' }),
			},
		)
		const body = (result as { data: { url: string; expiresAt: number } }).data
		const url = new URL(body.url)
		expect(url.origin).toBe('https://cafe.example.com')
		expect(url.pathname).toBe('/menu')
		expect(url.searchParams.get('location')).toBe('loc_1')
		expect(url.search).not.toContain('tc1')
		expect(decodeURIComponent(url.hash)).toBe('#test=tc1.loc_1.nonce.1.mac')
		expect(body.expiresAt).toBe(123)
	})

	it('refuses a location the member does not reach, and a missing one', async () => {
		mocks.locations.mockResolvedValue(['loc_2'])
		expect(await run('loc_1')).toMatchObject({ init: { status: 404 } })
		expect(mocks.client).not.toHaveBeenCalled()
		expect(await run(null)).toMatchObject({ init: { status: 400 } })
	})

	it('passes the region’s refusal on, such as the daily limit', async () => {
		mocks.fetchTenant.mockResolvedValue(
			Response.json({ error: 'test_order_limit' }, { status: 429 }),
		)
		const result = await run()
		expect(result).toMatchObject({
			data: { error: 'test_order_limit' },
			init: { status: 429 },
		})
	})

	it('answers unavailable when the region cannot be reached', async () => {
		mocks.fetchTenant.mockRejectedValue(new Error('offline'))
		expect(await run()).toMatchObject({
			data: { error: 'unavailable' },
			init: { status: 503 },
		})
	})
})
