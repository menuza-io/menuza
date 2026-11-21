import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	flag: vi.fn(),
	client: vi.fn(),
}))
vi.mock('@repo/common/feature-flags', () => ({ getFeatureFlag: mocks.flag }))
vi.mock('@repo/auth', () => ({ requireUserId: vi.fn(async () => 'user_1') }))
vi.mock('#app/utils/tenant-api.server.ts', () => ({
	getOperatorTenantClient: mocks.client,
}))
vi.mock('#app/utils/launch/launch.server.ts', () => ({
	orgSiteUrl: () => 'https://acme.menuza.site',
}))

import {
	readTargetPath,
	trackedQrScans,
	trackedQrUrl,
} from './short-links.server.ts'

const organization = { id: 'org_1', slug: 'acme', customDomain: null }
const print = {
	id: 'l1',
	code: 'k7m2p9x',
	kind: 'print',
	ref: 'design-1',
	targetPath: '/menu',
	clicksThisMonth: 12,
}

describe('tracked print QR (#159)', () => {
	let fetchTenant: ReturnType<typeof vi.fn>
	beforeEach(() => {
		fetchTenant = vi.fn()
		mocks.flag.mockResolvedValue(true)
		mocks.client.mockResolvedValue({ fetchTenant })
	})
	afterEach(() => vi.clearAllMocks())

	const input = (extra: Partial<Parameters<typeof trackedQrUrl>[0]> = {}) => ({
		request: new Request('http://localhost/x'),
		organization,
		designId: 'design-1',
		path: '/menu',
		canWrite: true,
		...extra,
	})

	it('is the plain page while the flag is off, without calling the region', async () => {
		mocks.flag.mockResolvedValue(false)
		expect(await trackedQrUrl(input())).toBeNull()
		expect(await trackedQrScans(input())).toBeNull()
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it("reuses the design's link when there is one", async () => {
		fetchTenant.mockImplementation(async () =>
			Response.json({ links: [print] }),
		)
		expect(await trackedQrUrl(input())).toBe(
			'https://acme.menuza.site/l/k7m2p9x',
		)
		expect(fetchTenant).toHaveBeenCalledTimes(1)
		expect(await trackedQrScans(input())).toBe(12)
	})

	it('makes the link on first use with the print UTM values, for a writer', async () => {
		fetchTenant
			.mockResolvedValueOnce(Response.json({ links: [] }))
			.mockResolvedValueOnce(Response.json({ link: print }, { status: 201 }))
		expect(await trackedQrUrl(input())).toBe(
			'https://acme.menuza.site/l/k7m2p9x',
		)
		const [path, init] = fetchTenant.mock.calls[1]!
		expect(path).toBe('/operator/marketing/short-links')
		expect(JSON.parse(init.body)).toEqual({
			kind: 'print',
			ref: 'design-1',
			targetPath: '/menu',
			utmSource: 'print',
			utmMedium: 'qr',
			utmCampaign: 'design-1',
		})
	})

	it('a viewer who cannot write only finds an existing link', async () => {
		fetchTenant.mockResolvedValue(Response.json({ links: [] }))
		expect(await trackedQrUrl(input({ canWrite: false }))).toBeNull()
		expect(fetchTenant).toHaveBeenCalledTimes(1)
	})

	it('a region that cannot make the link is an error, never a silently untracked code', async () => {
		fetchTenant
			.mockResolvedValueOnce(Response.json({ links: [] }))
			.mockResolvedValueOnce(new Response('no', { status: 503 }))
		await expect(trackedQrUrl(input())).rejects.toMatchObject({ status: 503 })
	})

	it('only a path on the own site can be a target', () => {
		expect(readTargetPath('/menu')).toBe('/menu')
		expect(readTargetPath('https://evil.example')).toBeNull()
		expect(readTargetPath('//evil.example')).toBeNull()
		expect(readTargetPath(42)).toBeNull()
	})
})
