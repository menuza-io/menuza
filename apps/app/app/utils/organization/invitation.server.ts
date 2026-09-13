import { webcrypto as crypto } from 'node:crypto'
import { invariantResponse } from '@epic-web/invariant'
import { markStepCompleted } from '@repo/common/onboarding'
import {
	and,
	db,
	desc,
	eq,
	gte,
	isNull,
	lt,
	or,
	Organization,
	OrganizationInvitation,
	OrganizationInviteLink,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { OrganizationInviteEmail, sendEmail } from '@repo/email'
import { type SQL } from 'drizzle-orm'
import { updateSeatQuantity } from '#app/utils/payments.server.ts'
import { MAX_ORGANIZATION_INVITES_PER_REQUEST } from './invitation.ts'
import { type OrganizationRoleName } from './organizations.server'

export { MAX_ORGANIZATION_INVITES_PER_REQUEST }

type PendingInvitation = NonNullable<
	Awaited<ReturnType<typeof getInvitationByToken>>
>

async function getAssignableOrganizationRole({
	organizationId,
	roleId,
	roleName,
}: {
	organizationId: string
	roleId?: string
	roleName?: OrganizationRoleName
}) {
	const [role] = await db
		.select()
		.from(OrganizationRole)
		.where(
			and(
				roleId
					? eq(OrganizationRole.id, roleId)
					: eq(OrganizationRole.name, roleName ?? 'member'),
				roleId
					? or(
							isNull(OrganizationRole.organizationId),
							eq(OrganizationRole.organizationId, organizationId),
						)
					: isNull(OrganizationRole.organizationId),
			),
		)
		.limit(1)
	if (!role) {
		throw new Error(
			roleId
				? `Organization role '${roleId}' is not assignable to this organization`
				: `Organization role '${roleName ?? 'member'}' not found`,
		)
	}
	return role
}

async function requireBuiltInAdminMembership(
	organizationId: string,
	userId: string,
) {
	const [membership] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.organizationRoleId, 'org_role_admin'),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)
	invariantResponse(
		membership,
		'Only organization admins can invite as Admin',
		{
			status: 403,
		},
	)
}

export async function validateOrganizationInviteRoles(
	organizationId: string,
	invites: Array<{ roleId?: string; role?: OrganizationRoleName }>,
) {
	await Promise.all(
		invites.map((invite) =>
			getAssignableOrganizationRole({
				organizationId,
				roleId: invite.roleId,
				roleName: invite.role,
			}),
		),
	)
}

export async function createOrganizationInvitation({
	organizationId,
	email: rawEmail,
	role = 'member',
	roleId,
	inviterId,
}: {
	organizationId: string
	email: string
	role?: OrganizationRoleName
	roleId?: string
	inviterId: string
}) {
	const email = rawEmail.toLowerCase().trim()
	const token = crypto.randomUUID()
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
	const organizationRole = await getAssignableOrganizationRole({
		organizationId,
		roleId,
		roleName: role,
	})
	if (organizationRole.id === 'org_role_admin') {
		await requireBuiltInAdminMembership(organizationId, inviterId)
	}
	const organizationRoleId = organizationRole.id
	const [existing] = await db
		.select({ id: OrganizationInvitation.id })
		.from(OrganizationInvitation)
		.where(
			and(
				eq(OrganizationInvitation.email, email),
				eq(OrganizationInvitation.organizationId, organizationId),
			),
		)
		.limit(1)
	await db
		.insert(OrganizationInvitation)
		.values({
			email,
			organizationId,
			token,
			organizationRoleId,
			expiresAt,
			inviterId,
		})
		.onConflictDoUpdate({
			target: [
				OrganizationInvitation.email,
				OrganizationInvitation.organizationId,
			],
			set: { token, organizationRoleId, expiresAt, inviterId },
		})
	const invitation = await getInvitationByToken(token)
	if (!invitation) throw new Error('Failed to create invitation')
	if (!existing) {
		await markStepCompleted(inviterId, organizationId, 'invite_members', {
			completedVia: 'member_invitation',
			invitedEmail: email,
			role: invitation.organizationRole.name,
		})
	}
	return { invitation, isNewInvitation: !existing }
}

export async function sendOrganizationInvitationEmail({
	invitation,
	organizationName,
	inviterName,
}: {
	invitation: { token: string; email: string }
	organizationName: string
	inviterName: string
}) {
	const baseUrl = process.env.BASE_URL
	if (!baseUrl) throw new Error('BASE_URL environment variable is required')
	return sendEmail({
		to: invitation.email,
		subject: `You're invited to join ${organizationName}`,
		react: OrganizationInviteEmail({
			inviteUrl: `${baseUrl}/join/${invitation.token}`,
			organizationName,
			inviterName,
		}),
	})
}

export async function getOrganizationInvitations(organizationId: string) {
	const rows = await db
		.select({
			invitation: OrganizationInvitation,
			organizationRole: OrganizationRole,
			inviter: User,
		})
		.from(OrganizationInvitation)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInvitation.organizationRoleId, OrganizationRole.id),
		)
		.leftJoin(User, eq(OrganizationInvitation.inviterId, User.id))
		.where(
			and(
				eq(OrganizationInvitation.organizationId, organizationId),
				gte(OrganizationInvitation.expiresAt, new Date()),
			),
		)
		.orderBy(desc(OrganizationInvitation.createdAt))
	return rows.map((row) => ({
		...row.invitation,
		organizationRole: row.organizationRole,
		inviter: row.inviter,
	}))
}

export async function deleteOrganizationInvitation(
	invitationId: string,
	organizationId: string,
) {
	return db
		.delete(OrganizationInvitation)
		.where(
			and(
				eq(OrganizationInvitation.id, invitationId),
				eq(OrganizationInvitation.organizationId, organizationId),
			),
		)
}

export async function getPendingInvitationsByEmail(email: string) {
	const rows = await db
		.select({
			invitation: OrganizationInvitation,
			organizationRole: OrganizationRole,
			organization: Organization,
		})
		.from(OrganizationInvitation)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInvitation.organizationRoleId, OrganizationRole.id),
		)
		.innerJoin(
			Organization,
			eq(OrganizationInvitation.organizationId, Organization.id),
		)
		.where(
			and(
				eq(OrganizationInvitation.email, email.toLowerCase()),
				gte(OrganizationInvitation.expiresAt, new Date()),
			),
		)
		.orderBy(desc(OrganizationInvitation.createdAt))
	return rows.map((row) => ({
		...row.invitation,
		organizationRole: row.organizationRole,
		organization: row.organization,
	}))
}

async function assertInvitationOwnedByUser(
	invitation: { email: string },
	userId: string,
) {
	const [user] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	invariantResponse(user, 'User not found', { status: 404 })
	invariantResponse(
		invitation.email.toLowerCase() === user.email.toLowerCase(),
		'This invitation was not sent to your email address',
		{ status: 403 },
	)
	return user
}

async function acceptInvitation(
	invitation: Pick<
		PendingInvitation,
		'id' | 'email' | 'organizationId' | 'organizationRoleId' | 'organization'
	>,
	userId: string,
) {
	await assertInvitationOwnedByUser(invitation, userId)
	const [member] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, invitation.organizationId),
			),
		)
		.limit(1)
	if (!member)
		await db
			.insert(UserOrganization)
			.values({
				userId,
				organizationId: invitation.organizationId,
				organizationRoleId: invitation.organizationRoleId,
				active: true,
			})
			.onConflictDoNothing()
	await db
		.delete(OrganizationInvitation)
		.where(eq(OrganizationInvitation.id, invitation.id))
	if (!member)
		await updateSeatQuantity(invitation.organizationId).catch(() => {})
	return { organization: invitation.organization, alreadyMember: !!member }
}

export async function acceptInvitationByEmail(email: string, userId: string) {
	const invitations = await getPendingInvitationsByEmail(email)
	const results = []
	for (const invitation of invitations)
		results.push(await acceptInvitation(invitation, userId))
	return results
}

export async function acceptInvitationById(
	invitationId: string,
	userId: string,
) {
	const invitation = await getInvitationById(invitationId)
	invariantResponse(invitation, 'Invitation not found', { status: 404 })
	if (invitation.expiresAt && invitation.expiresAt < new Date())
		throw new Error('Invitation has expired')
	return acceptInvitation(invitation, userId)
}

export async function validateAndAcceptInvitation(
	token: string,
	userId: string,
) {
	const invitation = await getInvitationByToken(token)
	invariantResponse(invitation, 'Invitation not found', { status: 404 })
	if (invitation.expiresAt && invitation.expiresAt < new Date())
		throw new Error('Invitation has expired')
	return acceptInvitation(invitation, userId)
}

export async function createOrganizationInviteLink({
	organizationId,
	role = 'member',
	roleId,
	createdById,
}: {
	organizationId: string
	role?: OrganizationRoleName
	roleId?: string
	createdById: string
}) {
	const token = crypto.randomUUID()
	const organizationRoleId = (
		await getAssignableOrganizationRole({
			organizationId,
			roleId,
			roleName: role,
		})
	).id
	await db
		.insert(OrganizationInviteLink)
		.values({ organizationId, token, organizationRoleId, createdById })
		.onConflictDoUpdate({
			target: [
				OrganizationInviteLink.organizationId,
				OrganizationInviteLink.createdById,
			],
			set: { token, organizationRoleId, isActive: true },
		})
	const [link] = await db
		.select({
			link: OrganizationInviteLink,
			organizationRole: OrganizationRole,
		})
		.from(OrganizationInviteLink)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInviteLink.organizationRoleId, OrganizationRole.id),
		)
		.where(eq(OrganizationInviteLink.token, token))
		.limit(1)
	return link ? { ...link.link, organizationRole: link.organizationRole } : null
}

export async function getOrganizationInviteLink(
	organizationId: string,
	createdById: string,
) {
	const [link] = await db
		.select({
			link: OrganizationInviteLink,
			organizationRole: OrganizationRole,
		})
		.from(OrganizationInviteLink)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInviteLink.organizationRoleId, OrganizationRole.id),
		)
		.where(
			and(
				eq(OrganizationInviteLink.organizationId, organizationId),
				eq(OrganizationInviteLink.createdById, createdById),
			),
		)
		.limit(1)
	return link ? { ...link.link, organizationRole: link.organizationRole } : null
}

export async function getAllOrganizationInviteLinks(organizationId: string) {
	const rows = await db
		.select({
			link: OrganizationInviteLink,
			organizationRole: OrganizationRole,
			createdBy: User,
		})
		.from(OrganizationInviteLink)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInviteLink.organizationRoleId, OrganizationRole.id),
		)
		.leftJoin(User, eq(OrganizationInviteLink.createdById, User.id))
		.where(
			and(
				eq(OrganizationInviteLink.organizationId, organizationId),
				eq(OrganizationInviteLink.isActive, true),
			),
		)
	return rows.map((row) => ({
		...row.link,
		organizationRole: row.organizationRole,
		createdBy: row.createdBy,
	}))
}

export async function deactivateOrganizationInviteLink(
	organizationId: string,
	createdById: string,
) {
	return db
		.update(OrganizationInviteLink)
		.set({ isActive: false })
		.where(
			and(
				eq(OrganizationInviteLink.organizationId, organizationId),
				eq(OrganizationInviteLink.createdById, createdById),
			),
		)
}

export async function validateInviteLink(token: string) {
	const [row] = await db
		.select({
			link: OrganizationInviteLink,
			organizationRole: OrganizationRole,
			organization: Organization,
		})
		.from(OrganizationInviteLink)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInviteLink.organizationRoleId, OrganizationRole.id),
		)
		.innerJoin(
			Organization,
			eq(OrganizationInviteLink.organizationId, Organization.id),
		)
		.where(eq(OrganizationInviteLink.token, token))
		.limit(1)
	if (!row) throw new Error('Invite link not found')
	if (!row.link.isActive) throw new Error('Invite link is no longer active')
	return {
		...row.link,
		organizationRole: row.organizationRole,
		organization: row.organization,
	}
}

export async function createInvitationFromLink(
	token: string,
	userEmail: string,
) {
	const link = await validateInviteLink(token)
	const email = userEmail.toLowerCase()
	const invitationToken = crypto.randomUUID()
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
	// Shareable links must not overwrite a still-valid email invitation.
	// A leaked member link would otherwise escalate a pending guest invite.
	// Expired rows occupying the unique (email, org) key may be replaced.
	await db
		.insert(OrganizationInvitation)
		.values({
			email,
			organizationId: link.organizationId,
			organizationRoleId: link.organizationRoleId,
			token: invitationToken,
			expiresAt,
			inviterId: link.createdById,
		})
		.onConflictDoUpdate({
			target: [
				OrganizationInvitation.email,
				OrganizationInvitation.organizationId,
			],
			set: {
				organizationRoleId: link.organizationRoleId,
				token: invitationToken,
				expiresAt,
				inviterId: link.createdById,
			},
			where: or(
				isNull(OrganizationInvitation.expiresAt),
				lt(OrganizationInvitation.expiresAt, new Date()),
			),
		})
	return getInvitationByEmailAndOrganization(email, link.organizationId)
}

export async function validateAndAcceptInviteLink(
	token: string,
	userId: string,
) {
	const link = await validateInviteLink(token)
	const [member] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, link.organizationId),
			),
		)
		.limit(1)
	if (!member) {
		await db
			.insert(UserOrganization)
			.values({
				userId,
				organizationId: link.organizationId,
				organizationRoleId: link.organizationRoleId,
				active: true,
			})
			.onConflictDoNothing()
		await updateSeatQuantity(link.organizationId).catch(() => {})
	}
	return { organization: link.organization, alreadyMember: !!member }
}

function mapInvitationRow(row: {
	invitation: typeof OrganizationInvitation.$inferSelect
	organizationRole: typeof OrganizationRole.$inferSelect
	organization: typeof Organization.$inferSelect
	inviter: typeof User.$inferSelect | null
}) {
	return {
		...row.invitation,
		organizationRole: row.organizationRole,
		organization: row.organization,
		inviter: row.inviter,
	}
}

async function findInvitation(where: SQL | undefined) {
	const [row] = await db
		.select({
			invitation: OrganizationInvitation,
			organizationRole: OrganizationRole,
			organization: Organization,
			inviter: User,
		})
		.from(OrganizationInvitation)
		.innerJoin(
			OrganizationRole,
			eq(OrganizationInvitation.organizationRoleId, OrganizationRole.id),
		)
		.innerJoin(
			Organization,
			eq(OrganizationInvitation.organizationId, Organization.id),
		)
		.leftJoin(User, eq(OrganizationInvitation.inviterId, User.id))
		.where(where)
		.limit(1)
	return row ? mapInvitationRow(row) : null
}

export async function getInvitationByToken(token: string) {
	return findInvitation(eq(OrganizationInvitation.token, token))
}

async function getInvitationById(invitationId: string) {
	return findInvitation(eq(OrganizationInvitation.id, invitationId))
}

async function getInvitationByEmailAndOrganization(
	email: string,
	organizationId: string,
) {
	return findInvitation(
		and(
			eq(OrganizationInvitation.email, email.toLowerCase().trim()),
			eq(OrganizationInvitation.organizationId, organizationId),
		),
	)
}
