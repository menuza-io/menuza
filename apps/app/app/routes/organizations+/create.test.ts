import { faker } from '@faker-js/faker'
import { db, eq, Organization, UserOrganization } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setMockLaunchStatus } from '#app/utils/env.server.ts'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action, loader } from './create.tsx'

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	provisionTenantDatabase: vi.fn(),
	deprovisionTenantDatabase: vi.fn(),
}))

describe('organizations+/create route integration', () => {
	beforeEach(() => {
		__setMockLaunchStatus('LAUNCHED')
		vi.mocked(provisionTenantDatabase).mockResolvedValue({ region: 'us' })
		vi.mocked(deprovisionTenantDatabase).mockResolvedValue({ region: 'us' })
	})

	afterEach(() => {
		__setMockLaunchStatus(null)
	})

	describe('loader', () => {
		it('redirects unauthenticated users to login', async () => {
			const request = new Request('http://localhost:3000/organizations/create')

			try {
				await loader({ request })
				expect.fail('Expected loader to redirect unauthenticated user')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(302)
				expect(error.headers.get('Location')).toContain('/login')
			}
		})

		it('redirects to /waitlist when launch status is CLOSED_BETA and user has no early access', async () => {
			__setMockLaunchStatus('CLOSED_BETA')
			const user = await createTestUser()
			const { cookie } = await createTestSession(user.id)

			const request = createAuthenticatedRequest(
				'http://localhost:3000/organizations/create',
				{},
				cookie,
			)

			try {
				await loader({ request })
				expect.fail('Expected loader to redirect user to waitlist')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(302)
				expect(error.headers.get('Location')).toBe('/waitlist')
			}
		})

		it('returns trial configuration and launch status for authenticated user', async () => {
			const user = await createTestUser()
			const { cookie } = await createTestSession(user.id)

			const request = createAuthenticatedRequest(
				'http://localhost:3000/organizations/create',
				{},
				cookie,
			)

			const result = await loader({ request })
			expect(result).toBeDefined()
			expect(result.trialConfig).toBeDefined()
			expect(result.launchStatus).toBe('LAUNCHED')
		})
	})

	describe('action', () => {
		it('redirects unauthenticated users to login', async () => {
			const formData = new FormData()
			formData.append('intent', 'create-organization')
			formData.append('name', 'Acme Corp')
			formData.append('slug', 'acme-corp')

			const request = new Request(
				'http://localhost:3000/organizations/create',
				{
					method: 'POST',
					body: formData,
				},
			)

			try {
				await action({
					request,
					params: {},
					context: {},
				} as any)
				expect.fail('Expected action to redirect unauthenticated user')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(302)
				expect(error.headers.get('Location')).toContain('/login')
			}
		})

		it('returns error when validation fails (invalid slug format)', async () => {
			const user = await createTestUser()
			const { cookie } = await createTestSession(user.id)

			const formData = new FormData()
			formData.append('intent', 'create-organization')
			formData.append('name', 'Test Org')
			formData.append('slug', '-invalid--slug-')

			const request = createAuthenticatedRequest(
				'http://localhost:3000/organizations/create',
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as any

			expect(response.status).toBe('error')
			expect(response.error?.slug).toBeDefined()
		})

		it('creates organization in database, adds user as admin, and redirects to step 2', async () => {
			const user = await createTestUser()
			const { cookie } = await createTestSession(user.id)

			const orgName = `Test Org ${Date.now()}`
			const orgSlug =
				`test-org-${Date.now()}-${faker.string.alphanumeric(4)}`.toLowerCase()

			const formData = new FormData()
			formData.append('intent', 'create-organization')
			formData.append('name', orgName)
			formData.append('slug', orgSlug)
			formData.append('description', 'A test organization')

			const request = createAuthenticatedRequest(
				'http://localhost:3000/organizations/create',
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			const location = response.headers.get('Location')
			expect(location).toContain('/organizations/create?step=2&orgId=')

			// Verify organization exists in SQLite database
			const [dbOrg] = await db
				.select()
				.from(Organization)
				.where(eq(Organization.slug, orgSlug))
				.limit(1)

			expect(dbOrg).toBeDefined()
			expect(dbOrg?.name).toBe(orgName)
			expect(dbOrg?.description).toBe('A test organization')

			// Verify user is an admin member in UserOrganization table
			const [membership] = await db
				.select()
				.from(UserOrganization)
				.where(eq(UserOrganization.organizationId, dbOrg!.id))
				.limit(1)

			expect(membership).toBeDefined()
			expect(membership?.userId).toBe(user.id)
			expect(membership?.organizationRoleId).toBe('org_role_admin')
		})

		it('handles complete-setup intent and redirects to org dashboard', async () => {
			const user = await createTestUser()
			const { cookie } = await createTestSession(user.id)
			const { createTestOrganization } = await import('#tests/test-utils.ts')
			const org = await createTestOrganization(user.id, 'admin')

			const formData = new FormData()
			formData.append('intent', 'complete-setup')
			formData.append('orgId', org.id)
			formData.append('organizationSize', '11-50')
			formData.append('userDepartment', 'engineering')

			const request = createAuthenticatedRequest(
				'http://localhost:3000/organizations/create',
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe(
				`/${org.slug}?celebrate=true`,
			)

			// Verify size updated on organization
			const [updatedOrg] = await db
				.select()
				.from(Organization)
				.where(eq(Organization.id, org.id))
				.limit(1)

			expect(updatedOrg?.size).toBe('11-50')
		})
	})
})
