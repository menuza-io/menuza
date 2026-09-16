import { faker } from '@faker-js/faker'
import {
	and,
	db,
	eq,
	OrganizationInvitation,
	OrganizationRole,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import type * as invitation from '#app/utils/organization/invitation.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './members.tsx'

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

vi.mock(
	'#app/utils/organization/invitation.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof invitation>()
		return {
			...actual,
			sendOrganizationInvitationEmail: vi
				.fn()
				.mockResolvedValue({ status: 'success' }),
		}
	},
)

describe('settings/members route integration', () => {
	describe('loader', () => {
		it('denies access to users who are not part of the organization', async () => {
			const outsider = await createTestUser()
			const { cookie } = await createTestSession(outsider.id)

			// Create org owned by a different user
			const owner = await createTestUser()
			const org = await createTestOrganization(owner.id, 'admin')

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${org.slug}/settings/members`,
				{},
				cookie,
			)

			try {
				await loader({
					request,
					params: { orgSlug: org.slug },
					context: {},
				} as any)
				expect.fail('Expected loader to deny non-member')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				// requireUserOrganization throws 404 or redirect for non-members
				expect([403, 404, 302]).toContain(error.status)
			}
		})

		it('returns members list and available roles for organization admin', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{},
				cookie,
			)

			const result = (await loader({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as any

			expect(result).toBeDefined()
			expect(result.members).toBeDefined()
			expect(result.members.length).toBeGreaterThanOrEqual(1)
			expect(result.availableRoles).toBeDefined()
			expect(result.pendingInvitations).toBeDefined()
			expect(result.organization.id).toBe(organization.id)
		})
	})

	describe('action', () => {
		it('assigns a custom role owned by the current organization', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const customRoleId = `org_role_custom_${faker.string.alphanumeric(12)}`
			await db.insert(OrganizationRole).values({
				id: customRoleId,
				name: 'Content coordinator',
				description: 'Can coordinate published content',
				level: 3,
				organizationId: organization.id,
			})
			const target = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: target.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
			})

			const formData = new FormData()
			formData.append('intent', 'update-member-role')
			formData.append('userId', target.id)
			formData.append('roleId', customRoleId)
			const response = (await action({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/members`,
					{ method: 'POST', body: formData },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(200)
			const [membership] = await db
				.select()
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.organizationId, organization.id),
						eq(UserOrganization.userId, target.id),
					),
				)
				.limit(1)
			expect(membership?.organizationRoleId).toBe(customRoleId)
		})

		it('rejects assigning a role owned by another organization', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const foreignOwner = await createTestUser()
			const foreignOrganization = await createTestOrganization(
				foreignOwner.id,
				'admin',
			)
			const foreignRoleId = `org_role_foreign_${faker.string.alphanumeric(12)}`
			await db.insert(OrganizationRole).values({
				id: foreignRoleId,
				name: 'Foreign role',
				description: 'Must not cross tenant boundaries',
				level: 3,
				organizationId: foreignOrganization.id,
			})
			const target = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: target.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
			})

			const formData = new FormData()
			formData.append('intent', 'update-member-role')
			formData.append('userId', target.id)
			formData.append('roleId', foreignRoleId)
			const response = (await action({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/members`,
					{ method: 'POST', body: formData },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(400)
			expect((await response.json()) as { error?: string }).toMatchObject({
				error: 'Role not found',
			})
		})

		it('invites a user with a custom role owned by the organization', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const customRoleId = `org_role_invite_${faker.string.alphanumeric(12)}`
			await db.insert(OrganizationRole).values({
				id: customRoleId,
				name: 'Event coordinator',
				description: 'Coordinates organization events',
				level: 2,
				organizationId: organization.id,
			})
			const inviteEmail = `custom-role-${faker.string.alphanumeric(8)}@example.com`
			const formData = new FormData()
			formData.append('intent', 'send-invitations')
			formData.append('invites[0].email', inviteEmail)
			formData.append('invites[0].roleId', customRoleId)
			const response = (await action({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/members`,
					{ method: 'POST', body: formData },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(200)
			const [invitation] = await db
				.select()
				.from(OrganizationInvitation)
				.where(
					and(
						eq(OrganizationInvitation.organizationId, organization.id),
						eq(OrganizationInvitation.email, inviteEmail.toLowerCase()),
					),
				)
				.limit(1)
			expect(invitation?.organizationRoleId).toBe(customRoleId)
		})

		it('sends invitation and creates OrganizationInvitation row in database', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const inviteEmail = `newmember_${Date.now()}@example.com`

			const formData = new FormData()
			formData.append('intent', 'send-invitations')
			formData.append('invites[0].email', inviteEmail)
			formData.append('invites[0].role', 'member')

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(200)

			// Verify invitation created in SQLite DB
			const [invitation] = await db
				.select()
				.from(OrganizationInvitation)
				.where(
					and(
						eq(OrganizationInvitation.organizationId, organization.id),
						eq(OrganizationInvitation.email, inviteEmail.toLowerCase()),
					),
				)
				.limit(1)

			expect(invitation).toBeDefined()
			expect(invitation?.organizationRoleId).toBe('org_role_member')
		})

		it('prevents a member from removing themselves', async () => {
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')

			const formData = new FormData()
			formData.append('intent', 'remove-member')
			formData.append('userId', user.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(400)
			const body = (await response.json()) as { error?: string }
			expect(body.error).toBe('You cannot remove yourself')
		})

		it('prevents removing the last admin in the organization', async () => {
			const { user: admin1, organization } = await setupTestOrgWithUser('admin')

			// Create a regular member
			const memberUser = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: memberUser.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
			})

			// Grant DELETE_MEMBER_ANY to the member role for this test
			const [insertedPermission] = await db
				.insert(_OrganizationPermissionToRole)
				.values({
					A: 'org_role_member',
					B: 'org_perm_delete_member_any',
				})
				.onConflictDoNothing()
				.returning()

			try {
				const { cookie: memberCookie } = await createTestSession(memberUser.id)

				// Attempt to remove admin1 (who is the sole admin)
				const formData = new FormData()
				formData.append('intent', 'remove-member')
				formData.append('userId', admin1.id)

				const request = createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/members`,
					{ method: 'POST', body: formData },
					memberCookie,
				)

				const response = (await action({
					request,
					params: { orgSlug: organization.slug },
					context: {},
				} as any)) as Response

				expect(getResponseStatus(response)).toBe(400)
				const body = (await response.json()) as { error?: string }
				expect(body.error).toContain('Cannot remove the last admin')
			} finally {
				if (insertedPermission) {
					await db
						.delete(_OrganizationPermissionToRole)
						.where(
							and(
								eq(_OrganizationPermissionToRole.A, 'org_role_member'),
								eq(
									_OrganizationPermissionToRole.B,
									'org_perm_delete_member_any',
								),
							),
						)
				}
			}
		})

		it('successfully removes a non-admin member from the organization', async () => {
			const { organization, cookie } = await setupTestOrgWithUser('admin')

			// Add a member to remove
			const targetMember = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: targetMember.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
				active: true,
			})

			const formData = new FormData()
			formData.append('intent', 'remove-member')
			formData.append('userId', targetMember.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(200)

			// Verify member active is false
			const [membership] = await db
				.select()
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.organizationId, organization.id),
						eq(UserOrganization.userId, targetMember.id),
					),
				)
				.limit(1)

			expect(membership?.active).toBe(false)
		})

		it('revokes a pending invitation', async () => {
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')
			const inviteEmail = `revoke_${Date.now()}@example.com`

			const [invitation] = await db
				.insert(OrganizationInvitation)
				.values({
					organizationId: organization.id,
					email: inviteEmail,
					organizationRoleId: 'org_role_member',
					token: `token-${faker.string.uuid()}`,
					inviterId: user.id,
					expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
				})
				.returning()

			const formData = new FormData()
			formData.append('intent', 'remove-invitation')
			formData.append('invitationId', invitation!.id)

			const request = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/members`,
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response

			expect(getResponseStatus(response)).toBe(200)

			// Verify invitation is removed from DB
			const [dbInvite] = await db
				.select()
				.from(OrganizationInvitation)
				.where(eq(OrganizationInvitation.id, invitation!.id))
				.limit(1)

			expect(dbInvite).toBeUndefined()
		})
	})
})
