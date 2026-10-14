import { faker } from '@faker-js/faker'
import { AuditAction, auditService } from '@repo/audit'
import {
	db,
	eq,
	OrganizationInvitation,
	UserOrganization,
} from '@repo/database'
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	acceptInvitationById,
	createOrganizationInvitation,
	createOrganizationInviteLink,
	validateAndAcceptInviteLink,
} from './invitation.server.ts'
import { auditMemberAdded } from './membership-audit.server.ts'

vi.mock('@repo/common/onboarding', () => ({
	markStepCompleted: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#app/utils/payments.server.ts', () => ({
	updateSeatQuantity: vi.fn().mockResolvedValue(null),
}))

async function seedInvitation({
	organizationId,
	email,
	inviterId,
}: {
	organizationId: string
	email: string
	inviterId: string
}) {
	const [invitation] = await db
		.insert(OrganizationInvitation)
		.values({
			organizationId,
			email,
			organizationRoleId: 'org_role_member',
			token: `token-${faker.string.uuid()}`,
			inviterId,
			expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
		})
		.returning()
	return invitation!
}

describe('membership audit emission', () => {
	let spy: MockInstance<typeof auditService.log>

	beforeEach(() => {
		spy = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const actions = () =>
		spy.mock.calls.map((call) => (call[0] as { action: AuditAction }).action)

	it('logs ORG_INVITATION_ACCEPTED then ORG_MEMBER_ADDED when a new member accepts', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const invitee = await createTestUser()
		const invitation = await seedInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
		})

		await acceptInvitationById(invitation.id, invitee.id)

		expect(actions()).toEqual([
			AuditAction.ORG_INVITATION_ACCEPTED,
			AuditAction.ORG_MEMBER_ADDED,
		])
		expect(spy.mock.calls[0]![0]).toMatchObject({
			userId: invitee.id,
			organizationId: organization.id,
			resourceId: invitation.id,
			metadata: { inviterId: owner.id, alreadyMember: false },
		})
		expect(spy.mock.calls[1]![0]).toMatchObject({
			userId: invitee.id,
			targetUserId: invitee.id,
			organizationId: organization.id,
			metadata: { via: 'invitation', roleId: 'org_role_member' },
		})
	})

	it('does not log ORG_MEMBER_ADDED when the user was already a member', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const invitee = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: invitee.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})
		const invitation = await seedInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
		})

		await acceptInvitationById(invitation.id, invitee.id)

		expect(actions()).toEqual([AuditAction.ORG_INVITATION_ACCEPTED])
		expect(spy.mock.calls[0]![0].metadata).toMatchObject({
			alreadyMember: true,
		})
	})

	it('logs nothing when the invitation belongs to a different email', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const attacker = await createTestUser()
		const invitation = await seedInvitation({
			organizationId: organization.id,
			email: `someone-else-${faker.string.alphanumeric(8)}@example.com`,
			inviterId: owner.id,
		})

		await expect(
			acceptInvitationById(invitation.id, attacker.id),
		).rejects.toBeDefined()

		expect(spy).not.toHaveBeenCalled()
		const [membership] = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, attacker.id))
		expect(membership).toBeUndefined()
	})

	it('logs nothing for an expired invitation', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const invitee = await createTestUser()
		const invitation = await seedInvitation({
			organizationId: organization.id,
			email: invitee.email,
			inviterId: owner.id,
		})
		await db
			.update(OrganizationInvitation)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(OrganizationInvitation.id, invitation.id))

		await expect(
			acceptInvitationById(invitation.id, invitee.id),
		).rejects.toThrow('expired')

		expect(spy).not.toHaveBeenCalled()
	})

	it('logs ORG_MEMBER_ADDED via the invite link when joining directly', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const link = await createOrganizationInviteLink({
			organizationId: organization.id,
			roleId: 'org_role_member',
			createdById: owner.id,
		})
		spy.mockClear()
		const joiner = await createTestUser()

		await validateAndAcceptInviteLink(link!.token, joiner.id)
		await validateAndAcceptInviteLink(link!.token, joiner.id)

		// The second call finds the user already a member and logs nothing.
		expect(actions()).toEqual([AuditAction.ORG_MEMBER_ADDED])
		expect(spy.mock.calls[0]![0]).toMatchObject({
			userId: joiner.id,
			targetUserId: joiner.id,
			organizationId: organization.id,
			metadata: { via: 'invite_link', inviteLinkId: link!.id },
		})
		expect(JSON.stringify(spy.mock.calls)).not.toContain(link!.token)
	})

	it('logs ORG_INVITATION_SENT from createOrganizationInvitation', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')

		await createOrganizationInvitation({
			organizationId: organization.id,
			email: 'New.Person@Example.com',
			inviterId: owner.id,
		})

		expect(actions()).toEqual([AuditAction.ORG_INVITATION_SENT])
		expect(spy.mock.calls[0]![0].metadata).toMatchObject({
			invitedEmail: 'new.person@example.com',
		})
	})

	it('does not log when the inviter lacks the right to assign an admin role', async () => {
		const owner = await createTestUser()
		const organization = await createTestOrganization(owner.id, 'admin')
		const member = await createTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: organization.id,
			organizationRoleId: 'org_role_member',
		})

		await expect(
			createOrganizationInvitation({
				organizationId: organization.id,
				email: `escalate-${faker.string.alphanumeric(6)}@example.com`,
				role: 'admin',
				inviterId: member.id,
			}),
		).rejects.toBeDefined()

		expect(spy).not.toHaveBeenCalled()
	})

	it('swallows audit failures so a membership change is never rolled back by logging', async () => {
		spy.mockRejectedValue(new Error('audit store unavailable'))
		vi.spyOn(console, 'error').mockImplementation(() => {})

		await expect(
			auditMemberAdded({
				organizationId: 'org-1',
				memberUserId: 'user-1',
				via: 'invitation',
			}),
		).resolves.toBeUndefined()
	})
})
