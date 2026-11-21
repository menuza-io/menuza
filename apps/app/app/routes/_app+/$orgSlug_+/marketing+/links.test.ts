import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	isShortLinksOn,
	type ShortLinkRow,
} from '#app/utils/marketing/short-links.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import { action, loader } from './links.tsx'
import { activateTestLingui } from './test-lingui.ts'

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return { ...actual, requireUserWithOrganizationPermission: vi.fn() }
	},
)
vi.mock(
	'#app/utils/marketing/short-links.server.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#app/utils/marketing/short-links.server.ts')
			>()
		return { ...actual, isShortLinksOn: vi.fn() }
	},
)
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	return {
		...actual,
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [{ slug: 'acme', customDomain: null }],
					}),
				}),
			}),
		},
	}
})

const row: ShortLinkRow = {
	id: 'l1',
	code: 'k7m2p9x',
	kind: 'link',
	ref: null,
	label: 'Window sticker',
	targetPath: '/menu',
	utmSource: null,
	utmMedium: null,
	utmCampaign: null,
	utmContent: null,
	disabled: false,
	createdAt: 1,
	clicksThisMonth: 4,
	clicksTotal: 9,
	daily: [],
}

function post(fields: Record<string, string>) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	return new Request('http://localhost/acme/marketing/links', {
		method: 'POST',
		body: form,
	})
}

describe('Marketing links route (#159)', () => {
	let fetchTenant: ReturnType<typeof vi.fn>
	const args = (request: Request) =>
		({ request, params: { orgSlug: 'acme' }, context: {} }) as never

	beforeEach(() => {
		activateTestLingui()
		fetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue('user_1')
		vi.mocked(isShortLinksOn).mockResolvedValue(true)
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

	it('the loader needs read:campaign, lists the links and is a 404 while the flag is off', async () => {
		fetchTenant.mockResolvedValue(Response.json({ links: [row] }))
		const result = (await loader(args(new Request('http://localhost/x')))) as {
			links: ShortLinkRow[]
			siteOrigin: string
		}
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			'org_1',
			ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		)
		expect(result.links).toHaveLength(1)
		expect(fetchTenant.mock.calls[0]![0]).toBe(
			'/operator/marketing/short-links?kind=link',
		)

		vi.mocked(isShortLinksOn).mockResolvedValue(false)
		await expect(
			loader(args(new Request('http://localhost/x'))),
		).rejects.toMatchObject({
			status: 404,
		})
	})

	it('the action needs update:campaign and is a 404 with the flag off', async () => {
		fetchTenant.mockResolvedValue(Response.json({ link: row }, { status: 201 }))
		await action(args(post({ intent: 'create', targetPath: '/menu' })))
		expect(requireUserWithOrganizationPermission).toHaveBeenCalledWith(
			expect.anything(),
			'org_1',
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		)
		vi.mocked(isShortLinksOn).mockResolvedValue(false)
		await expect(
			action(args(post({ intent: 'create', targetPath: '/menu' }))),
		).rejects.toMatchObject({ status: 404 })
	})

	it('a link to another domain is refused here, without calling the region', async () => {
		for (const targetPath of [
			'https://evil.example/phish',
			'//evil.example',
			'javascript:alert(1)',
			'menu',
		]) {
			const result = (await action(
				args(post({ intent: 'create', targetPath })),
			)) as { error?: string }
			expect(result.error, targetPath).toBeTruthy()
		}
		expect(fetchTenant).not.toHaveBeenCalled()
	})

	it('creates a link for a page of the site and turns one off and on', async () => {
		fetchTenant.mockResolvedValue(Response.json({ link: row }, { status: 201 }))
		const created = await action(
			args(
				post({
					intent: 'create',
					label: 'Window sticker',
					targetPath: '/menu?item=1',
					utmSource: 'sticker',
				}),
			),
		)
		expect(created).toEqual({ ok: true })
		const [path, init] = fetchTenant.mock.calls[0]!
		expect(path).toBe('/operator/marketing/short-links')
		expect(JSON.parse(init.body)).toEqual({
			kind: 'link',
			label: 'Window sticker',
			targetPath: '/menu?item=1',
			utmSource: 'sticker',
		})

		fetchTenant.mockClear()
		fetchTenant.mockResolvedValue(Response.json({ link: row }))
		await action(args(post({ intent: 'disable', id: 'l1' })))
		expect(fetchTenant.mock.calls[0]![0]).toBe(
			'/operator/marketing/short-links/l1',
		)
		expect(JSON.parse(fetchTenant.mock.calls[0]![1].body)).toEqual({
			disabled: true,
		})
		await action(args(post({ intent: 'enable', id: 'l1' })))
		expect(JSON.parse(fetchTenant.mock.calls[1]![1].body)).toEqual({
			disabled: false,
		})
	})

	it('says so when the region refuses', async () => {
		fetchTenant.mockResolvedValue(
			Response.json({ error: 'too_many_links' }, { status: 400 }),
		)
		const result = (await action(
			args(post({ intent: 'create', targetPath: '/menu' })),
		)) as { error?: string }
		expect(result.error).toMatch(/limit/i)
	})
})
