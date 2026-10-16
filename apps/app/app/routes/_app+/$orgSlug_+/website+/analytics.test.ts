import { requireUserId } from '@repo/auth'
import type * as DatabaseModule from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { mockDb, queryChain, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { action } from './analytics.tsx'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.DATABASE_URL = 'file:./data.db'
})

vi.mock('@repo/auth', () => ({
	requireUserId: vi.fn(),
}))

vi.mock('@repo/cache', () => ({
	invalidateUserOrganizationsCache: vi.fn(),
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
		eq: drizzleOperator,
	}
})

const testOrg = { id: 'org-123', slug: 'test-org', customDomain: null }

function captureUpdates() {
	const updates: unknown[] = []
	mockDb.update.mockImplementation(() => {
		const chain = queryChain()
		chain.set = (values: unknown) => {
			updates.push(values)
			return chain
		}
		return chain
	})
	return updates
}

function submit(fields: Record<string, string>) {
	const formData = new FormData()
	formData.set('intent', 'update-site-analytics')
	formData.set('organizationId', testOrg.id)
	for (const [name, value] of Object.entries(fields)) {
		formData.set(name, value)
	}
	return action({
		request: new Request('http://localhost/test-org/website/analytics', {
			method: 'POST',
			body: formData,
		}),
		params: { orgSlug: testOrg.slug },
		context: {},
	} as any)
}

describe('website analytics action', () => {
	beforeEach(() => {
		resetMockDb()
		vi.mocked(requireUserId).mockResolvedValue('user-123' as any)
		vi.mocked(requireUserOrganization).mockResolvedValue(testOrg as any)
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue(
			undefined as any,
		)
	})

	it('saves one ID and stores the blank fields as null', async () => {
		const updates = captureUpdates()

		const response = await submit({
			facebookPixelId: '',
			googleTagManagerId: '',
			googleAnalyticsId: 'G-ABC123',
			tiktokPixelId: '',
		})

		expect(response.status).toBe(302)
		expect(updates).toEqual([
			{
				facebookPixelId: null,
				googleTagManagerId: null,
				googleAnalyticsId: 'G-ABC123',
				tiktokPixelId: null,
			},
		])
		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			testOrg.id,
			testOrg.slug,
			testOrg.customDomain,
		)
	})

	it('clears a saved ID to null when it is resubmitted blank', async () => {
		const updates = captureUpdates()

		await submit({ googleAnalyticsId: 'G-ABC123' })
		await submit({ googleAnalyticsId: '   ' })

		expect(updates).toHaveLength(2)
		expect(updates[1]).toMatchObject({ googleAnalyticsId: null })
	})
})
