import { parseWithZod } from '@conform-to/zod'
import { auditService, AuditAction } from '@repo/audit'
import { requireUserId } from '@repo/auth'
import { invalidateUserOrganizationsCache } from '@repo/cache'
import {
	alias,
	and,
	db,
	desc,
	eq,
	exists,
	ne,
	or,
	isNull,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useLoaderData,
	useActionData,
} from 'react-router'
import { z } from 'zod'

import { InvitationsCard } from '#app/components/settings/cards/organization/invitations-card.tsx'
import { MembersCard } from '#app/components/settings/cards/organization/members-card.tsx'

import {
	createOrganizationInvitation,
	validateOrganizationInviteRoles,
	sendOrganizationInvitationEmail,
	getOrganizationInvitations,
	deleteOrganizationInvitation,
	createOrganizationInviteLink,
	getOrganizationInviteLink,
	deactivateOrganizationInviteLink,
} from '#app/utils/organization/invitation.server.ts'
import { MAX_ORGANIZATION_INVITES_PER_REQUEST } from '#app/utils/organization/invitation.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
	getUserOrganizationPermissionsForClient,
} from '#app/utils/organization/permissions.server.ts'
import { updateSeatQuantity } from '#app/utils/payments.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	ORGANIZATION_INVITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	// Check if user has permission to view members
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_MEMBER_ANY,
	)

	const [
		pendingInvitations,
		members,
		inviteLink,
		availableRoles,
		userPermissions,
	] = await Promise.all([
		getOrganizationInvitations(organization.id),
		db.query.UserOrganization.findMany({
			columns: {
				userId: true,
				organizationId: true,
				active: true,
				createdAt: true,
			},
			with: {
				user: {
					columns: { id: true, name: true, email: true },
					with: { image: { columns: { id: true, altText: true } } },
				},
				organizationRole: {
					columns: { id: true, name: true, description: true, level: true },
				},
			},
			where: (membership, { and, eq }) =>
				and(
					eq(membership.organizationId, organization.id),
					eq(membership.active, true),
				),
			orderBy: (membership, { asc }) => [asc(membership.createdAt)],
		}),
		getOrganizationInviteLink(organization.id, userId),
		getAvailableRoles(organization.id),
		getUserOrganizationPermissionsForClient(userId, organization.id),
	])
	const canManageRoles = members.some(
		(member) =>
			member.userId === userId &&
			member.active &&
			member.organizationRole.id === 'org_role_admin',
	)

	return {
		organization,
		pendingInvitations,
		members,
		inviteLink,
		availableRoles: canManageRoles
			? availableRoles
			: availableRoles.filter((role) => role.id !== 'org_role_admin'),
		currentUserId: userId,
		userPermissions,
		canManageRoles,
	}
}

// Get available roles from the database
async function getAvailableRoles(organizationId: string) {
	const roles = await db
		.select({
			id: OrganizationRole.id,
			name: OrganizationRole.name,
			description: OrganizationRole.description,
			organizationId: OrganizationRole.organizationId,
		})
		.from(OrganizationRole)
		.where(
			or(
				isNull(OrganizationRole.organizationId),
				eq(OrganizationRole.organizationId, organizationId),
			),
		)
		.orderBy(desc(OrganizationRole.level))
	return roles.map((role) => ({
		...role,
		isBuiltIn: role.organizationId === null,
	}))
}

const InviteSchema = z.object({
	invites: z
		.array(
			z
				.object({
					email: z.string().email('Invalid email address'),
					roleId: z.string().min(1).optional(),
					// Accept legacy callers while all current forms submit roleId.
					role: z
						.enum(['admin', 'member', 'viewer', 'guest'] as const)
						.optional(),
				})
				.superRefine((value, ctx) => {
					if (!value.roleId && !value.role) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: 'A role is required',
							path: ['roleId'],
						})
					}
				}),
		)
		.min(1, 'At least one invite is required')
		.max(
			MAX_ORGANIZATION_INVITES_PER_REQUEST,
			`You can invite at most ${MAX_ORGANIZATION_INVITES_PER_REQUEST} people at a time`,
		),
})

function otherActiveAdminsExist(organizationId: string, excludeUserId: string) {
	const OtherMembership = alias(UserOrganization, 'otherMembership')
	return exists(
		db
			.select({ userId: OtherMembership.userId })
			.from(OtherMembership)
			.innerJoin(
				OrganizationRole,
				eq(OtherMembership.organizationRoleId, OrganizationRole.id),
			)
			.where(
				and(
					eq(OtherMembership.organizationId, organizationId),
					eq(OtherMembership.active, true),
					eq(OrganizationRole.id, 'org_role_admin'),
					ne(OtherMembership.userId, excludeUserId),
				),
			),
	)
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'send-invitations') {
		// Check if user has permission to invite members
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEMBER_ANY,
		)

		const rateLimitCheck = await checkRateLimit(
			{ type: 'user', value: `${userId}:${organization.id}` },
			ORGANIZATION_INVITE_RATE_LIMIT,
		)
		if (!rateLimitCheck.allowed) {
			return createRateLimitResponse(rateLimitCheck.resetAt)
		}

		const submission = parseWithZod(formData, { schema: InviteSchema })

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() }, { status: 400 })
		}

		const { invites } = submission.value

		try {
			await validateOrganizationInviteRoles(organization.id, invites, userId)

			const [currentUser] = await db
				.select({ name: User.name, email: User.email })
				.from(User)
				.where(eq(User.id, userId))
				.limit(1)

			for (const invite of invites) {
				const { invitation } = await createOrganizationInvitation({
					organizationId: organization.id,
					email: invite.email,
					roleId: invite.roleId,
					role: invite.role,
					inviterId: userId,
				})

				await sendOrganizationInvitationEmail({
					invitation,
					organizationName: organization.name,
					inviterName: currentUser?.name || currentUser?.email || 'Someone',
				})
			}

			return Response.json({ result: submission.reply({ resetForm: true }) })
		} catch (error) {
			console.error('Error sending invitations:', error)
			if (error instanceof Response) return error
			if (
				error instanceof Error &&
				error.message.includes('not assignable to this organization')
			) {
				return Response.json(
					{ error: 'That role is not available in this organization' },
					{ status: 400 },
				)
			}
			return Response.json(
				{
					result: submission.reply({
						formErrors: ['An error occurred while sending the invitations.'],
					}),
				},
				{ status: 500 },
			)
		}
	}

	if (intent === 'remove-invitation') {
		// Check if user has permission to manage members
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.DELETE_MEMBER_ANY,
		)

		const invitationId = formData.get('invitationId') as string

		try {
			await deleteOrganizationInvitation(invitationId, organization.id)
			return Response.json({ success: true })
		} catch (error) {
			console.error('Error removing invitation:', error)
			return Response.json(
				{ error: 'Failed to remove invitation' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'remove-member') {
		// Check if user has permission to remove members
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.DELETE_MEMBER_ANY,
		)

		const memberUserId = formData.get('userId') as string

		if (memberUserId === userId) {
			return Response.json(
				{ error: 'You cannot remove yourself' },
				{ status: 400 },
			)
		}

		try {
			const [removed] = await db
				.update(UserOrganization)
				.set({
					active: false,
				})
				.where(
					and(
						eq(UserOrganization.userId, memberUserId),
						eq(UserOrganization.organizationId, organization.id),
						or(
							ne(UserOrganization.organizationRoleId, 'org_role_admin'),
							otherActiveAdminsExist(organization.id, memberUserId),
						),
					),
				)
				.returning({ userId: UserOrganization.userId })

			if (!removed) {
				const [target] = await db
					.select({
						userId: UserOrganization.userId,
						roleId: OrganizationRole.id,
						active: UserOrganization.active,
					})
					.from(UserOrganization)
					.innerJoin(
						OrganizationRole,
						eq(UserOrganization.organizationRoleId, OrganizationRole.id),
					)
					.where(
						and(
							eq(UserOrganization.userId, memberUserId),
							eq(UserOrganization.organizationId, organization.id),
						),
					)
					.limit(1)
				if (target?.active && target.roleId === 'org_role_admin') {
					return Response.json(
						{ error: 'Cannot remove the last admin of the organization' },
						{ status: 400 },
					)
				}
				return Response.json({ error: 'Member not found' }, { status: 404 })
			}

			try {
				await updateSeatQuantity(organization.id)
			} catch (error) {
				console.error(
					'Failed to update seat quantity after removing user:',
					error,
				)
			}

			return Response.json({ success: true })
		} catch (error) {
			console.error('Error removing member:', error)
			return Response.json(
				{ error: 'Failed to remove member' },
				{ status: 500 },
			)
		}
	}

	// --- update-member-role intent ---
	if (intent === 'update-member-role') {
		// Role reassignment is intentionally restricted to the shared built-in
		// admin role. A tenant role with UPDATE_MEMBER_ANY must not be able to
		// grant itself more authority.
		const [currentMembership] = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organization.id),
					eq(UserOrganization.organizationRoleId, 'org_role_admin'),
					eq(UserOrganization.active, true),
				),
			)
			.limit(1)
		if (!currentMembership) {
			return Response.json(
				{ error: 'Only organization admins can update member roles' },
				{ status: 403 },
			)
		}

		const memberUserId = formData.get('userId')
		const submittedRoleId = formData.get('roleId')
		const legacyRoleName = formData.get('role')

		if (!memberUserId || typeof memberUserId !== 'string') {
			return Response.json({ error: 'Missing userId' }, { status: 400 })
		}
		if (
			(!submittedRoleId || typeof submittedRoleId !== 'string') &&
			(!legacyRoleName || typeof legacyRoleName !== 'string')
		) {
			return Response.json({ error: 'Missing role' }, { status: 400 })
		}
		if (memberUserId === userId) {
			return Response.json(
				{ error: 'You cannot change your own role' },
				{ status: 400 },
			)
		}

		const [organizationRole] = await db
			.select({ id: OrganizationRole.id })
			.from(OrganizationRole)
			.where(
				and(
					submittedRoleId && typeof submittedRoleId === 'string'
						? eq(OrganizationRole.id, submittedRoleId)
						: eq(OrganizationRole.name, legacyRoleName as string),
					submittedRoleId && typeof submittedRoleId === 'string'
						? or(
								isNull(OrganizationRole.organizationId),
								eq(OrganizationRole.organizationId, organization.id),
							)
						: isNull(OrganizationRole.organizationId),
				),
			)
			.limit(1)

		if (!organizationRole) {
			return Response.json({ error: 'Role not found' }, { status: 400 })
		}

		try {
			const lastAdminGuard =
				organizationRole.id !== 'org_role_admin'
					? or(
							ne(UserOrganization.organizationRoleId, 'org_role_admin'),
							otherActiveAdminsExist(organization.id, memberUserId),
						)
					: undefined

			const [existingMembership] = await db
				.select({ organizationRoleId: UserOrganization.organizationRoleId })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, memberUserId),
						eq(UserOrganization.organizationId, organization.id),
					),
				)
				.limit(1)

			const [updated] = await db
				.update(UserOrganization)
				.set({
					organizationRoleId: organizationRole.id,
				})
				.where(
					and(
						eq(UserOrganization.userId, memberUserId),
						eq(UserOrganization.organizationId, organization.id),
						lastAdminGuard,
					),
				)
				.returning({ userId: UserOrganization.userId })

			if (!updated) {
				const [existing] = await db
					.select({ userId: UserOrganization.userId })
					.from(UserOrganization)
					.where(
						and(
							eq(UserOrganization.userId, memberUserId),
							eq(UserOrganization.organizationId, organization.id),
						),
					)
					.limit(1)
				if (!existing) {
					return Response.json({ error: 'Member not found' }, { status: 404 })
				}
				return Response.json(
					{ error: 'Cannot demote the last admin of the organization' },
					{ status: 400 },
				)
			}
			try {
				await invalidateUserOrganizationsCache(memberUserId)
			} catch (cacheError) {
				console.error(
					'Failed to invalidate user org cache after role update:',
					cacheError,
				)
			}
			await auditService.log({
				action: AuditAction.ORG_MEMBER_ROLE_CHANGED,
				userId,
				targetUserId: memberUserId,
				organizationId: organization.id,
				details: 'Organization member role changed',
				metadata: {
					oldRoleId: existingMembership?.organizationRoleId,
					newRoleId: organizationRole.id,
				},
			})
			return Response.json({ success: true })
		} catch (error) {
			console.error('Error updating member role:', error)
			return Response.json(
				{ error: 'Failed to update member role' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'create-invite-link') {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEMBER_ANY,
		)

		try {
			const inviteLink = await createOrganizationInviteLink({
				organizationId: organization.id,
				roleId: 'org_role_member',
				createdById: userId,
			})
			return Response.json({ success: true, inviteLink })
		} catch (error) {
			console.error('Error creating invite link:', error)
			return Response.json(
				{ error: 'Failed to create invite link' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'reset-invite-link') {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEMBER_ANY,
		)

		try {
			const inviteLink = await createOrganizationInviteLink({
				organizationId: organization.id,
				roleId: 'org_role_member',
				createdById: userId,
			})
			return Response.json({ success: true, inviteLink })
		} catch (error) {
			console.error('Error resetting invite link:', error)
			return Response.json(
				{ error: 'Failed to reset invite link' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'deactivate-invite-link') {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.DELETE_MEMBER_ANY,
		)

		try {
			await deactivateOrganizationInviteLink(organization.id, userId)
			return Response.json({ success: true })
		} catch (error) {
			console.error('Error deactivating invite link:', error)
			return Response.json(
				{ error: 'Failed to deactivate invite link' },
				{ status: 500 },
			)
		}
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function MembersSettings() {
	const {
		organization,
		pendingInvitations,
		members,
		inviteLink,
		availableRoles,
		currentUserId,
		canManageRoles,
	} = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<MembersCard
					members={members}
					currentUserId={currentUserId}
					availableRoles={availableRoles}
					organizationSlug={organization.slug}
					canManageRoles={canManageRoles}
				/>
			</AnnotatedSection>

			<AnnotatedSection>
				<InvitationsCard
					pendingInvitations={pendingInvitations}
					inviteLink={inviteLink}
					actionData={actionData}
					availableRoles={availableRoles}
					organizationSlug={organization.slug}
					canManageRoles={canManageRoles}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
