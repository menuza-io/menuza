import { faker } from '@faker-js/faker'
import { AuditAction, auditService } from '@repo/audit'
import {
	and,
	db,
	eq,
	OrganizationInvitation,
	OrganizationRole,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
	describe('audit trail', () => {
		afterEach(() => {
			vi.restoreAllMocks()
		})

		async function post(
			organization: { slug: string },
			cookie: string,
			fields: Record<string, string>,
		) {
			const formData = new FormData()
			for (const [key, value] of Object.entries(fields))
				formData.append(key, value)
			return (await action({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/settings/members`,
					{ method: 'POST', body: formData },
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as any)) as Response
		}

		function loggedActions(spy: { mock: { calls: unknown[][] } }) {
			return spy.mock.calls.map(
				(call) => (call[0] as { action: AuditAction }).action,
			)
		}

		it('logs ORG_INVITATION_SENT with the actor and organization', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')
			const email = `audit-invite-${faker.string.alphanumeric(8)}@example.com`

			const response = await post(organization, cookie, {
				intent: 'send-invitations',
				'invites[0].email': email,
				'invites[0].role': 'member',
			})

			expect(getResponseStatus(response)).toBe(200)
			expect(spy).toHaveBeenCalledTimes(1)
			expect(spy.mock.calls[0]![0]).toMatchObject({
				action: AuditAction.ORG_INVITATION_SENT,
				userId: user.id,
				organizationId: organization.id,
				resourceType: 'organization_invitation',
				metadata: {
					invitedEmail: email.toLowerCase(),
					roleId: 'org_role_member',
					isResend: false,
				},
			})
		})

		it('marks a repeat invitation to the same email as a resend', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const email = `audit-resend-${faker.string.alphanumeric(8)}@example.com`
			const fields = {
				intent: 'send-invitations',
				'invites[0].email': email,
				'invites[0].role': 'member',
			}

			await post(organization, cookie, fields)
			await post(organization, cookie, fields)

			expect(spy).toHaveBeenCalledTimes(2)
			expect(spy.mock.calls[1]![0].metadata).toMatchObject({ isResend: true })
		})

		it('logs ORG_INVITATION_REVOKED only when an invitation was removed', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')
			const [invitation] = await db
				.insert(OrganizationInvitation)
				.values({
					organizationId: organization.id,
					email: `audit-revoke-${faker.string.alphanumeric(8)}@example.com`,
					organizationRoleId: 'org_role_member',
					token: `token-${faker.string.uuid()}`,
					inviterId: user.id,
					expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
				})
				.returning()

			await post(organization, cookie, {
				intent: 'remove-invitation',
				invitationId: invitation!.id,
			})
			expect(loggedActions(spy)).toEqual([AuditAction.ORG_INVITATION_REVOKED])
			expect(spy.mock.calls[0]![0]).toMatchObject({
				userId: user.id,
				organizationId: organization.id,
				resourceId: invitation!.id,
			})

			// Revoking it again, or one that belongs to another organization, is a no-op.
			spy.mockClear()
			await post(organization, cookie, {
				intent: 'remove-invitation',
				invitationId: invitation!.id,
			})
			expect(spy).not.toHaveBeenCalled()
		})

		it('does not log a revoke for an invitation in another organization', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const other = await setupTestOrgWithUser('admin')
			const [foreign] = await db
				.insert(OrganizationInvitation)
				.values({
					organizationId: other.organization.id,
					email: `audit-foreign-${faker.string.alphanumeric(8)}@example.com`,
					organizationRoleId: 'org_role_member',
					token: `token-${faker.string.uuid()}`,
					inviterId: other.user.id,
					expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
				})
				.returning()

			await post(organization, cookie, {
				intent: 'remove-invitation',
				invitationId: foreign!.id,
			})

			expect(spy).not.toHaveBeenCalled()
			const [stillThere] = await db
				.select()
				.from(OrganizationInvitation)
				.where(eq(OrganizationInvitation.id, foreign!.id))
			expect(stillThere).toBeDefined()
		})

		it('logs ORG_MEMBER_REMOVED for a removed member and nothing for rejected removals', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')
			const target = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: target.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
				active: true,
			})

			// Rejected: removing yourself, and removing a non-member.
			await post(organization, cookie, {
				intent: 'remove-member',
				userId: user.id,
			})
			await post(organization, cookie, {
				intent: 'remove-member',
				userId: 'user-that-is-not-a-member',
			})
			expect(spy).not.toHaveBeenCalled()

			const response = await post(organization, cookie, {
				intent: 'remove-member',
				userId: target.id,
			})
			expect(getResponseStatus(response)).toBe(200)
			expect(spy).toHaveBeenCalledTimes(1)
			expect(spy.mock.calls[0]![0]).toMatchObject({
				action: AuditAction.ORG_MEMBER_REMOVED,
				userId: user.id,
				targetUserId: target.id,
				organizationId: organization.id,
			})
		})

		it('does not log a second removal for an already inactive member', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { organization, cookie } = await setupTestOrgWithUser('admin')
			const target = await createTestUser()
			await db.insert(UserOrganization).values({
				userId: target.id,
				organizationId: organization.id,
				organizationRoleId: 'org_role_member',
				active: false,
			})

			await post(organization, cookie, {
				intent: 'remove-member',
				userId: target.id,
			})

			expect(spy).not.toHaveBeenCalled()
		})

		it('logs invite link create, regenerate and disable', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { user, organization, cookie } = await setupTestOrgWithUser('admin')

			await post(organization, cookie, { intent: 'create-invite-link' })
			await post(organization, cookie, { intent: 'reset-invite-link' })
			await post(organization, cookie, { intent: 'deactivate-invite-link' })
			// A second disable has nothing active left to disable.
			await post(organization, cookie, { intent: 'deactivate-invite-link' })

			expect(loggedActions(spy)).toEqual([
				AuditAction.ORG_INVITE_LINK_CREATED,
				AuditAction.ORG_INVITE_LINK_CREATED,
				AuditAction.ORG_INVITE_LINK_DISABLED,
			])
			expect(spy.mock.calls[0]![0]).toMatchObject({
				userId: user.id,
				organizationId: organization.id,
				metadata: { regenerated: false },
			})
			expect(spy.mock.calls[1]![0].metadata).toMatchObject({
				regenerated: true,
			})
		})

		it('never puts the invite token in the audit metadata', async () => {
			const spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const { organization, cookie } = await setupTestOrgWithUser('admin')

			const response = await post(organization, cookie, {
				intent: 'create-invite-link',
			})
			const { inviteLink } = (await response.json()) as {
				inviteLink: { token: string }
			}

			expect(JSON.stringify(spy.mock.calls)).not.toContain(inviteLink.token)
		})

		it('does not fail the request when the audit write throws', async () => {
			vi.spyOn(auditService, 'log').mockRejectedValue(new Error('db down'))
			vi.spyOn(console, 'error').mockImplementation(() => {})
			const { organization, cookie } = await setupTestOrgWithUser('admin')

			const response = await post(organization, cookie, {
				intent: 'create-invite-link',
			})

			expect(getResponseStatus(response)).toBe(200)
		})
	})
})
