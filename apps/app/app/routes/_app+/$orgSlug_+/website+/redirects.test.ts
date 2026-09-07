import { requireUserId } from '@repo/auth'
import type * as DatabaseModule from '@repo/database'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { mockSelectResults, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { loader, action } from './redirects.tsx'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.DATABASE_URL = 'file:./data.db'
})

vi.mock('@repo/auth', () => ({
	requireUserId: vi.fn(),
}))

vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(),
}))

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return {
			...actual,
			ORG_PERMISSIONS: {
				READ_WEBSITE_ANY: 'read:website:any',
				UPDATE_WEBSITE_ANY: 'update:website:any',
			},
			requireUserWithOrganizationPermission: vi.fn(),
		}
	},
)

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const { mockDb, drizzleTable, drizzleOperator } =
		await import('#tests/setup/drizzle-mock.ts')
	return {
		...actual,
		db: mockDb,
		Organization: drizzleTable,
		WebsiteRedirect: drizzleTable,
		WebsiteNotFoundLog: drizzleTable,
		WebsitePage: drizzleTable,
		and: drizzleOperator,
		eq: drizzleOperator,
		ne: drizzleOperator,
		desc: vi.fn(),
	}
})

describe('Website Redirects Route', () => {
	const testOrg = {
		id: 'org-123',
		slug: 'test-org',
		customDomain: 'test.com',
	}

	beforeEach(() => {
		resetMockDb()
		vi.clearAllMocks()
		vi.mocked(requireUserId).mockResolvedValue('user-123' as any)
		vi.mocked(requireUserOrganization).mockResolvedValue(testOrg as any)
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue(
			undefined as any,
		)
	})

	it('loader returns redirects, 404 logs, and pages', async () => {
		mockSelectResults(
			[
				{
					id: 'r1',
					fromPath: '/old-about',
					toPath: '/about',
					statusCode: 301,
					isEnabled: true,
					hitCount: 5,
					lastTriggeredAt: new Date('2026-01-01'),
					createdAt: new Date('2026-01-01'),
				},
			],
			[
				{
					id: 'l1',
					path: '/missing',
					hitCount: 2,
					firstHitAt: new Date('2026-01-01'),
					lastHitAt: new Date('2026-01-02'),
					lastReferrer: 'https://google.com',
				},
			],
			[
				{
					id: 'p1',
					title: 'Home',
					slug: 'home',
					isHomePage: true,
				},
			],
		)

		const result = await loader({
			request: new Request('http://localhost/test-org/website/redirects'),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(result.redirects).toHaveLength(1)
		expect(result.redirects[0]!.fromPath).toBe('/old-about')
		expect(result.notFoundLogs).toHaveLength(1)
		expect(result.notFoundLogs[0]!.path).toBe('/missing')
		expect(result.pages).toHaveLength(1)
		expect(result.pages[0]!.title).toBe('Home')
	})

	it('action create-redirect successfully creates a redirect and purges cache', async () => {
		// Mock duplicate check returning empty
		mockSelectResults([])

		const formData = new FormData()
		formData.set('intent', 'create-redirect')
		formData.set('fromPath', 'old-contact/')
		formData.set('toPath', '/contact')
		formData.set('statusCode', '301')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			testOrg.id,
			testOrg.slug,
			testOrg.customDomain,
		)
		expect(response.status).toBe(302)
	})

	it('action create-redirect prevents circular redirect', async () => {
		const formData = new FormData()
		formData.set('intent', 'create-redirect')
		formData.set('fromPath', '/contact')
		formData.set('toPath', '/contact')
		formData.set('statusCode', '301')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(response.status).toBe(400)
		const data = (await response.json()) as any
		expect(data.errors.toPath[0]).toContain('Destination cannot be the same')
	})

	it('action create-redirect prevents indirect circular redirect loop', async () => {
		// First select: duplicate check returns empty
		// Second select: detectRedirectCycle returns existing redirect /b -> /a
		mockSelectResults([], [{ id: 'r1', fromPath: '/b', toPath: '/a' }])

		const formData = new FormData()
		formData.set('intent', 'create-redirect')
		formData.set('fromPath', '/a')
		formData.set('toPath', '/b')
		formData.set('statusCode', '301')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(response.status).toBe(400)
		const data = (await response.json()) as any
		expect(data.errors.toPath[0]).toContain('circular loop')
	})

	it('action update-redirect prevents indirect circular redirect loop', async () => {
		// First select: duplicate check (excluding self) returns empty
		// Second select: detectRedirectCycle returns existing redirect /b -> /c, /c -> /a
		mockSelectResults(
			[],
			[
				{ id: 'r1', fromPath: '/a', toPath: '/x' },
				{ id: 'r2', fromPath: '/b', toPath: '/c' },
				{ id: 'r3', fromPath: '/c', toPath: '/a' },
			],
		)

		const formData = new FormData()
		formData.set('intent', 'update-redirect')
		formData.set('id', 'r1')
		formData.set('fromPath', '/a')
		formData.set('toPath', '/b')
		formData.set('statusCode', '301')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(response.status).toBe(400)
		const data = (await response.json()) as any
		expect(data.errors.toPath[0]).toContain('circular loop')
	})

	it('action create-redirect rejects scheme-relative destinations', async () => {
		const formData = new FormData()
		formData.set('intent', 'create-redirect')
		formData.set('fromPath', '/old-path')
		formData.set('toPath', '//evil.com')
		formData.set('statusCode', '301')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(response.status).toBe(400)
		const data = (await response.json()) as any
		expect(data.errors.toPath[0]).toBeDefined()
	})

	it('action toggle-redirect toggles redirect status and purges cache', async () => {
		const formData = new FormData()
		formData.set('intent', 'toggle-redirect')
		formData.set('id', 'r1')
		formData.set('isEnabled', 'false')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
		expect(response.status).toBe(302)
	})

	it('action delete-redirect deletes redirect and purges cache', async () => {
		const formData = new FormData()
		formData.set('intent', 'delete-redirect')
		formData.set('id', 'r1')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
		expect(response.status).toBe(302)
	})

	it('action clear-all-not-founds deletes all 404 logs', async () => {
		const formData = new FormData()
		formData.set('intent', 'clear-all-not-founds')

		const response = await action({
			request: new Request('http://localhost/test-org/website/redirects', {
				method: 'POST',
				body: formData,
			}),
			params: { orgSlug: 'test-org' },
			context: {},
		} as any)

		expect(response.status).toBe(302)
	})
})
