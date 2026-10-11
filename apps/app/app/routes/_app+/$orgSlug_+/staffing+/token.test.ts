import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader } from './token.ts'

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	locations: vi.fn(),
	client: vi.fn(),
}))
vi.mock('#app/utils/staffing/access.server.ts', () => ({
	getStaffingAccess: mocks.access,
}))
vi.mock('#app/utils/staffing/locations.server.ts', () => ({
	loadStaffingLocations: mocks.locations,
}))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))

const enabledFlags = {
	enabled: true,
	scheduling: true,
	timeclock: false,
	pay: false,
	hiring: false,
	onboarding: false,
}

function run() {
	return loader({
		request: new Request('https://app.example/cafe/staffing/token'),
		params: { orgSlug: 'cafe' },
		context: {} as never,
	} as unknown as Parameters<typeof loader>[0])
}

describe('staffing credentials', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.access.mockResolvedValue({
			orgId: 'org_1',
			userId: 'user_1',
			dataRegion: 'us',
			flags: enabledFlags,
			grants: { staff: 'write', schedule: 'read', timeclock: null },
			impersonating: false,
			canViewPay: false,
		})
		mocks.locations.mockResolvedValue([
			{
				id: 'loc_1',
				name: 'Main',
				timezone: 'America/New_York',
				isActive: true,
			},
		])
		mocks.client.mockResolvedValue({
			jwt: 'scoped',
			tenantApiUrl: 'https://regional.example',
		})
	})

	it('mints only the areas the operator was granted, with signed locations', async () => {
		const result = await run()
		expect(mocks.client).toHaveBeenCalledWith(expect.any(Request), 'cafe', {
			scope: 'staffing',
			claims: {
				areas: { staff: 'write', schedule: 'read' },
				locationIds: null,
				locations: [{ id: 'loc_1', tz: 'America/New_York' }],
				canViewPay: false,
			},
		})
		expect(result.data).toMatchObject({
			jwt: 'scoped',
			tenantApiUrl: 'https://regional.example',
		})
		expect(result.init?.headers).toMatchObject({
			'Cache-Control': 'private, no-store',
		})
	})

	it('looks like a missing page when the flag is off', async () => {
		mocks.access.mockResolvedValue({
			...(await mocks.access()),
			flags: { ...enabledFlags, enabled: false },
		})
		await expect(run()).rejects.toMatchObject({ status: 404 })
		expect(mocks.client).not.toHaveBeenCalled()
	})

	it('refuses operators without any staffing grant', async () => {
		mocks.access.mockResolvedValue({
			...(await mocks.access()),
			grants: { staff: null, schedule: null, timeclock: null },
		})
		await expect(run()).rejects.toMatchObject({ status: 403 })
		expect(mocks.client).not.toHaveBeenCalled()
	})
})
