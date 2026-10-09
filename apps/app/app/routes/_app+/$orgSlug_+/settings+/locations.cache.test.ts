import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action as editAction } from './locations.$locationId.tsx'
import { action as indexAction } from './locations._index.tsx'
import { action as newAction } from './locations.new.tsx'

const mocks = vi.hoisted(() => {
	// Every query-builder call returns the same chain; awaiting it yields `rows`.
	const state = { rows: [] as unknown[] }
	const chain: any = new Proxy(() => {}, {
		get(_target, prop) {
			if (prop === 'then') {
				return (resolve: (value: unknown) => void) => resolve(state.rows)
			}
			if (prop === 'returning') return async () => [{ id: 'loc-new' }]
			return () => chain
		},
		apply: () => chain,
	})
	return {
		state,
		db: {
			select: () => chain,
			update: () => chain,
			insert: () => chain,
			delete: () => chain,
			transaction: async (fn: (tx: unknown) => unknown) => fn(chain),
		},
		purgeOrganizationSiteCache: vi.fn(),
	}
})

vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mocks.db,
}))
vi.mock('@repo/auth', () => ({ requireUserId: vi.fn(async () => 'user-1') }))
vi.mock('@repo/common/toast', () => ({
	redirectWithToast: vi.fn(
		async (url: string) =>
			new Response(null, { status: 302, headers: { Location: url } }),
	),
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(async () => ({ id: 'org-1', slug: 'acme' })),
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	requireUserWithOrganizationPermission: vi.fn(),
	ORG_PERMISSIONS: { UPDATE_SETTINGS_ANY: 'update:settings:any' },
}))
vi.mock('#app/utils/phone-agent/phone-agent.server.ts', () => ({
	deleteScopeData: vi.fn(),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: mocks.purgeOrganizationSiteCache,
}))

function post(fields: Record<string, string>) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return new Request('https://app.example/acme/settings/locations', {
		method: 'POST',
		body,
	})
}

const LOCATION_FIELDS = {
	name: 'Main',
	slug: 'main',
	timezone: 'America/Chicago',
	isActive: 'true',
	isDefault: 'true',
	onlineHours: JSON.stringify([
		{
			day: 'thursday',
			isOpen: true,
			slots: [{ start: '09:00', end: '23:00' }],
		},
	]),
}

describe('location changes purge the published site cache', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state.rows = []
	})

	it('purges after saving a location', async () => {
		const response = await editAction({
			request: post(LOCATION_FIELDS),
			params: { orgSlug: 'acme', locationId: 'loc-1' },
		} as any)

		expect((response as Response).status).toBe(302)
		expect(mocks.purgeOrganizationSiteCache).toHaveBeenCalledWith(
			'org-1',
			'acme',
		)
	})

	it('does not purge when the save is rejected', async () => {
		await editAction({
			request: post({ ...LOCATION_FIELDS, slug: 'Not A Slug' }),
			params: { orgSlug: 'acme', locationId: 'loc-1' },
		} as any)

		expect(mocks.purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('purges after creating a location', async () => {
		const response = await newAction({
			request: post(LOCATION_FIELDS),
			params: { orgSlug: 'acme' },
		} as any)

		expect((response as Response).status).toBe(302)
		expect(mocks.purgeOrganizationSiteCache).toHaveBeenCalledWith(
			'org-1',
			'acme',
		)
	})

	it.each([
		['toggle-active', { isActive: 'false' }],
		['set-default', {}],
		['delete-location', {}],
	])('purges after %s', async (intent, extra) => {
		mocks.state.rows = [{ id: 'loc-1', isDefault: false }]

		const result = await indexAction({
			request: post({ intent, locationId: 'loc-1', ...extra }),
			params: { orgSlug: 'acme' },
		} as any)

		expect(result).toEqual({ success: true })
		expect(mocks.purgeOrganizationSiteCache).toHaveBeenCalledWith(
			'org-1',
			'acme',
		)
	})
})
