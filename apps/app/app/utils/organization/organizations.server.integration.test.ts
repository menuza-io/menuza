import { faker } from '@faker-js/faker'
import { db, eq, Organization, UserOrganization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	checkUserOrganizationAccess,
	createOrganization,
	discoverOrganizationFromEmail,
	getOrganizationByDomain,
	getOrganizationBySlug,
	getOrganizationWithAccess,
	getUserDefaultOrganization,
	getUserOrganizations,
	getUserOrganizationsWithSlugHandling,
	setUserDefaultOrganization,
	userHasOrganizationRole,
	userHasOrgAccess,
} from './organizations.server.ts'

describe('organizations.server integration', () => {
	it('creates an organization with admin membership and default home page', async () => {
		const user = await createTestUser()
		const slug =
			`corp-${Date.now()}-${faker.string.alphanumeric(4)}`.toLowerCase()

		const org = await createOrganization({
			name: 'Test Corporation',
			slug,
			description: 'A test corporation description',
			userId: user.id,
		})

		expect(org).toBeDefined()
		expect(org.id).toBeDefined()
		expect(org.slug).toBe(slug)

		// Verify membership was established in SQLite
		const [membership] = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.organizationId, org.id))
			.limit(1)

		expect(membership).toBeDefined()
		expect(membership?.userId).toBe(user.id)
		expect(membership?.organizationRoleId).toBe('org_role_admin')
		expect(membership?.isDefault).toBe(true)
	})

	it('loads organization by slug and ignores inactive organizations', async () => {
		const user = await createTestUser()
		const org = await createTestOrganization(user.id, 'admin')

		const loaded = await getOrganizationBySlug(org.slug)
		expect(loaded).toBeDefined()
		expect(loaded?.id).toBe(org.id)

		// Deactivate organization
		await db
			.update(Organization)
			.set({ active: false })
			.where(eq(Organization.id, org.id))

		const inactiveLoaded = await getOrganizationBySlug(org.slug)
		expect(inactiveLoaded).toBeNull()
	})

	it('discovers organization by domain and email', async () => {
		const user = await createTestUser()
		const domain = `test-${Date.now()}.com`
		const org = await createTestOrganization(user.id, 'admin')

		await db
			.update(Organization)
			.set({ verifiedDomain: domain })
			.where(eq(Organization.id, org.id))

		const byDomain = await getOrganizationByDomain(domain)
		expect(byDomain).toBeDefined()
		expect(byDomain?.id).toBe(org.id)

		const byEmail = await discoverOrganizationFromEmail(`alice@${domain}`)
		expect(byEmail).toBeDefined()
		expect(byEmail?.id).toBe(org.id)

		const nonExistent = await discoverOrganizationFromEmail(
			'alice@unknown-domain.io',
		)
		expect(nonExistent).toBeNull()
	})

	it('sets and retrieves default organization for user across multiple orgs', async () => {
		const user = await createTestUser()
		const org1 = await createTestOrganization(user.id, 'admin')
		const org2 = await createTestOrganization(user.id, 'admin')

		await setUserDefaultOrganization(user.id, org1.id)
		const defaultOrg1 = await getUserDefaultOrganization(user.id)
		expect(defaultOrg1?.organization.id).toBe(org1.id)

		await setUserDefaultOrganization(user.id, org2.id)
		const defaultOrg2 = await getUserDefaultOrganization(user.id)
		expect(defaultOrg2?.organization.id).toBe(org2.id)
	})

	it('loads all memberships and organization permissions in a batched query path', async () => {
		const user = await createTestUser()
		const firstOrg = await createTestOrganization(user.id, 'admin')
		const secondOrg = await createTestOrganization(user.id, 'member')

		const organizations = await getUserOrganizations(user.id, true)

		expect(organizations.map((item) => item.organization.id)).toEqual(
			expect.arrayContaining([firstOrg.id, secondOrg.id]),
		)
		expect(
			organizations.every((item) => item.organizationRole.permissions),
		).toBe(true)
	})

	it('keeps role permissions on the current organization resolved from the default org', async () => {
		const user = await createTestUser()
		const org = await createTestOrganization(user.id, 'admin')
		await setUserDefaultOrganization(user.id, org.id)

		const result = await getUserOrganizationsWithSlugHandling(user.id, org.slug)

		expect(result.currentOrganization?.organization.id).toBe(org.id)
		expect(result.currentOrganization?.organizationRole.permissions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: 'read', entity: 'website' }),
				expect.objectContaining({ action: 'read', entity: 'announcement' }),
				expect.objectContaining({ action: 'update', entity: 'campaign' }),
			]),
		)
	})

	it('checks user organization access and returns role information', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')

		const access = await checkUserOrganizationAccess(user.id, organization.id)
		expect(access).toBeDefined()
		expect(access?.userId).toBe(user.id)
		expect(access?.organizationRole.name).toBe('admin')

		const nonMember = await createTestUser()
		const noAccess = await checkUserOrganizationAccess(
			nonMember.id,
			organization.id,
		)
		expect(noAccess).toBeNull()
	})

	it('validates userHasOrgAccess from Request with 403 on forbidden', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')

		const request = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}`,
			{},
			cookie,
		)

		const access = await userHasOrgAccess(request, organization.id)
		expect(access).toBe(true)

		// Different user request
		const outsider = await createTestUser()
		const { cookie: outsiderCookie } = await createTestSession(outsider.id)
		const unauthorizedRequest = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}`,
			{},
			outsiderCookie,
		)

		try {
			await userHasOrgAccess(unauthorizedRequest, organization.id)
			expect.fail('Expected 403 response')
		} catch (error: any) {
			expect(error).toBeInstanceOf(Response)
			expect(error.status).toBe(403)
		}
	})

	it('checks organization role hierarchy with userHasOrganizationRole', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')

		// Admin has level 4, which satisfies admin, member, viewer, and guest requirements
		expect(
			await userHasOrganizationRole(user.id, organization.id, 'admin'),
		).toBe(true)
		expect(
			await userHasOrganizationRole(user.id, organization.id, 'member'),
		).toBe(true)
		expect(
			await userHasOrganizationRole(user.id, organization.id, 'guest'),
		).toBe(true)

		// Create a guest user (level 1)
		const guest = await createTestUser()
		await addOrganizationMember(guest.id, organization.id, 'org_role_guest')

		expect(
			await userHasOrganizationRole(guest.id, organization.id, 'guest'),
		).toBe(true)
		expect(
			await userHasOrganizationRole(guest.id, organization.id, 'admin'),
		).toBe(false)
	})

	it('loads organization with access filtering columns', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')

		const data = await getOrganizationWithAccess(organization.slug, user.id, {
			id: true,
			name: true,
		})

		expect(data.id).toBe(organization.id)
		expect(data.name).toBe(organization.name)
		expect(data.slug).toBeUndefined()
	})
})
