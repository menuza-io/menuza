import { parseWithZod } from '@conform-to/zod/v4'
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
	not,
	or,
	isNull,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { memberLocationScopeInputSchema } from '@repo/staffing-restaurant'
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

import { notifyChat } from '#app/utils/chat/namespace.server.ts'
import { hasPendingErasure } from '#app/utils/gdpr.server.ts'
import {
	resolveAllMemberLocationIds,
	scopesShareALocation,
} from '#app/utils/location/member-scope.server.ts'
import { listLocationTags } from '#app/utils/location/tags.server.ts'
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
	assertCanManageMember,
	loadMemberActor,
	manageableMemberIds,
	memberCheckResponse,
	type MemberActor,
} from '#app/utils/organization/member-management.server.ts'
import {
	auditInvitationRevoked,
	auditInviteLinkDisabled,
	auditMemberLocationsChanged,
	auditMemberRemoved,
} from '#app/utils/organization/membership-audit.server.ts'
import {
	requireAnyUserWithOrganizationPermission,
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
	getUserOrganizationPermissionsForClient,
} from '#app/utils/organization/permissions.server.ts'
import { updateSeatQuantity } from '#app/utils/payments.server.ts'
import { deleteCanvaConnection } from '#app/utils/print/canva/connection.server.ts'
import {
	checkRateLimit,
	createRateLimitResponse,
	ORGANIZATION_INVITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	enqueueStaffingOutbox,
	flushStaffingOutboxFor,
} from '#app/utils/staffing/outbox.server.ts'
import {
	listMemberLocationAccess,
	listScopableLocations,
	setMemberLocationScope,
} from '#app/utils/staffing/restaurant/location-scope.server.ts'

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

	const actor = await loadMemberActor(userId, organization.id)
	const [
		pendingInvitations,
		allMembers,
		inviteLink,
		availableRoles,
		userPermissions,
		memberScopes,
		locations,
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
		resolveAllMemberLocationIds(organization.id),
		listScopableLocations(organization.id),
	])
	const canManageRoles = allMembers.some(
		(member) =>
			member.userId === userId &&
			member.active &&
			member.organizationRole.id === 'org_role_admin',
	)
	const canManageTeam = Boolean(
		actor && (actor.isAdmin || actor.manageOwnLocations),
	)
	// A location manager sees only the members who share one of their
	// locations (#126); everyone else sees the whole team as before.
	const restricted = Boolean(actor && !actor.isAdmin && actor.scope !== null)
	// `null` is every location; a member with no entry reaches none.
	const scopeOf = (id: string) =>
		memberScopes.has(id) ? memberScopes.get(id)! : []
	const members = restricted
		? allMembers.filter(
				(member) =>
					member.userId === userId ||
					scopesShareALocation(actor!.scope, scopeOf(member.userId)),
			)
		: allMembers
	const visibleInvitations =
		restricted && actor
			? pendingInvitations.filter(
					(invitation) =>
						invitation.inviterId === userId ||
						(invitation.locationScope !== 'all' &&
							scopesShareALocation(actor.scope, invitation.locationIds)),
				)
			: pendingInvitations
	const manageable = actor
		? await manageableMemberIds(
				actor,
				members.map((member) => ({
					userId: member.userId,
					roleId: member.organizationRole.id,
				})),
				memberScopes,
			)
		: new Set<string>()

	// Removing needs delete:member:any (any member, as before) or a location
	// manager's authority over this member.
	const removable = new Set(manageable)
	if (
		actor &&
		!restricted &&
		actor.permissions.has('delete:member:any')
	) {
		for (const member of members) {
			if (member.userId !== userId) removable.add(member.userId)
		}
	}

	// The Locations control exists for admins and location managers of an
	// organization that has locations. A location manager picks only from their
	// own locations and never assigns tags.
	const locationControl =
		canManageTeam && locations.length > 0
			? await loadLocationControl(organization.id, actor!, locations)
			: null
	const roleOptions =
		canManageRoles || !actor
			? availableRoles
			: await assignableRoles(actor, availableRoles)

	return {
		organization,
		pendingInvitations: visibleInvitations,
		members,
		inviteLink,
		staffingLocations: locationControl,
		memberLocationNames: Object.fromEntries(
			locations.map((location) => [location.id, location.name]),
		),
		memberScopes: Object.fromEntries(
			members.map((member) => [member.userId, scopeOf(member.userId)]),
		),
		manageableUserIds: [...manageable],
		removableUserIds: [...removable],
		availableRoles: roleOptions,
		currentUserId: userId,
		userPermissions,
		canManageRoles,
		canManageTeam,
		// null means every location: the invite form then offers all of them.
		invitableLocationIds: actor && !actor.isAdmin ? actor.scope : null,
	}
}

async function assignableRoles<T extends { id: string }>(
	actor: MemberActor,
	roles: T[],
): Promise<T[]> {
	const out: T[] = []
	for (const role of roles) {
		const check = await assertCanManageMember(actor, {
			action: 'invite',
			roleId: role.id,
			scope: actor.scope === null ? 'all' : 'selected',
			locationIds: actor.scope ?? [],
		})
		if (check.ok) out.push(role)
	}
	return out
}

async function loadLocationControl(
	organizationId: string,
	actor: MemberActor,
	locations: Array<{ id: string; name: string }>,
) {
	const [access, tags] = await Promise.all([
		listMemberLocationAccess(organizationId),
		actor.isAdmin ? listLocationTags(organizationId) : Promise.resolve([]),
	])
	const scopable =
		actor.isAdmin || actor.scope === null
			? locations
			: locations.filter((location) => actor.scope!.includes(location.id))
	if (scopable.length === 0) return null
	return {
		locations: scopable,
		access: Object.fromEntries(access),
		tags: tags.map((tag) => ({
			id: tag.id,
			name: tag.name,
			locationCount: tag.locationIds.length,
		})),
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
					email: z
						.string({ error: 'Enter an email address' })
						.email('Invalid email address'),
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
					// An admin whose account is scheduled for deletion is leaving too.
					not(hasPendingErasure(OtherMembership.userId)),
				),
			),
	)
}

/** The refusal `Response` for a team change the actor may not make, or null. */
async function refuseMemberChange(
	actorId: string,
	organizationId: string,
	input: Parameters<typeof assertCanManageMember>[1],
) {
	const actor = await loadMemberActor(actorId, organizationId)
	if (!actor) {
		return Response.json({ error: 'Not found' }, { status: 404 })
	}
	const check = await assertCanManageMember(actor, input)
	return check.ok ? null : memberCheckResponse(check)
}

/**
 * A shared invite link joins as Member with every location, so someone limited
 * to some locations cannot make one (#126).
 */
async function refuseScopedInviteLink(actorId: string, organizationId: string) {
	const actor = await loadMemberActor(actorId, organizationId)
	if (!actor || actor.isAdmin || actor.scope === null) return null
	return memberCheckResponse({
		ok: false,
		code: 'location_not_in_your_scope',
		status: 403,
		error: 'An invite link gives access to every location.',
	})
}

/**
 * Whoever is not an admin may only revoke an invitation they sent, or one whose
 * locations lie inside their own.
 */
async function refuseInvitationOutsideScope(
	actorId: string,
	organizationId: string,
	invitationId: string,
) {
	const actor = await loadMemberActor(actorId, organizationId)
	if (!actor || actor.isAdmin || actor.scope === null) return null
	const invitations = await getOrganizationInvitations(organizationId)
	const invitation = invitations.find((row) => row.id === invitationId)
	if (!invitation || invitation.inviterId === actorId) return null
	const inside =
		invitation.locationScope !== 'all' &&
		invitation.locationIds.every((id) => actor.scope!.includes(id))
	return inside
		? null
		: memberCheckResponse({
				ok: false,
				code: 'member_outside_your_scope',
				status: 403,
				error:
					'This invitation is for locations outside yours, so you cannot change it.',
			})
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
		// Check if user has permission to invite members. A location manager may
		// invite too, within their own locations (#126).
		await requireAnyUserWithOrganizationPermission(request, organization.id, [
			ORG_PERMISSIONS.CREATE_MEMBER_ANY,
			ORG_PERMISSIONS.UPDATE_MEMBER_OWN_LOCATIONS,
		])

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
		const inviteLocations = {
			locationScope:
				formData.get('locationScope') === 'selected'
					? ('selected' as const)
					: ('all' as const),
			locationIds: formData.getAll('locationIds').map(String),
		}

		try {
			await validateOrganizationInviteRoles(
				organization.id,
				invites,
				userId,
				inviteLocations,
			)

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
					locationScope: inviteLocations.locationScope,
					locationIds: inviteLocations.locationIds,
					request,
				})

				await sendOrganizationInvitationEmail({
					invitation,
					organizationName: organization.name,
					inviterName: currentUser?.name || currentUser?.email || 'Someone',
				})
			}

			return Response.json({ result: submission.reply({ resetForm: true }) })
		} catch (error) {
			// A refused grant (location or role outside the inviter's own) is a
			// normal answer, not a fault.
			if (error instanceof Response) return error
			console.error('Error sending invitations:', error)
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
		await requireAnyUserWithOrganizationPermission(request, organization.id, [
			ORG_PERMISSIONS.DELETE_MEMBER_ANY,
			ORG_PERMISSIONS.UPDATE_MEMBER_OWN_LOCATIONS,
		])

		const invitationId = formData.get('invitationId') as string
		const refusedInvitation = await refuseInvitationOutsideScope(
			userId,
			organization.id,
			invitationId,
		)
		if (refusedInvitation) return refusedInvitation

		try {
			const revoked = await deleteOrganizationInvitation(
				invitationId,
				organization.id,
			)
			if (revoked.length > 0) {
				await auditInvitationRevoked({
					organizationId: organization.id,
					actorId: userId,
					invitationId,
					request,
				})
			}
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
		await requireAnyUserWithOrganizationPermission(request, organization.id, [
			ORG_PERMISSIONS.DELETE_MEMBER_ANY,
			ORG_PERMISSIONS.UPDATE_MEMBER_OWN_LOCATIONS,
		])

		const memberUserId = formData.get('userId') as string

		if (memberUserId === userId) {
			return Response.json(
				{ error: 'You cannot remove yourself' },
				{ status: 400 },
			)
		}

		try {
			// Like role changes, removing a built-in admin is reserved for built-in
			// admins: a tenant role with DELETE_MEMBER_ANY must not be able to lock
			// admins out of the organization.
			const [targetMembership] = await db
				.select({ roleId: UserOrganization.organizationRoleId })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, memberUserId),
						eq(UserOrganization.organizationId, organization.id),
					),
				)
				.limit(1)
			// Anyone who is not an admin may only remove members inside their own
			// locations (#126). An admin target is handled by the check below.
			if (targetMembership && targetMembership.roleId !== 'org_role_admin') {
				const refused = await refuseMemberChange(userId, organization.id, {
					action: 'remove',
					targetUserId: memberUserId,
				})
				if (refused) return refused
			}
			if (targetMembership?.roleId === 'org_role_admin') {
				const [actorAdmin] = await db
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
				// The sole admin falls through to the last-admin check below.
				const [otherAdmin] = actorAdmin
					? []
					: await db
							.select({ userId: UserOrganization.userId })
							.from(UserOrganization)
							.where(
								and(
									eq(UserOrganization.organizationId, organization.id),
									eq(UserOrganization.organizationRoleId, 'org_role_admin'),
									eq(UserOrganization.active, true),
									ne(UserOrganization.userId, memberUserId),
								),
							)
							.limit(1)
				if (!actorAdmin && otherAdmin) {
					return Response.json(
						{ error: 'Only organization admins can remove admins' },
						{ status: 403 },
					)
				}
			}

			// Removing an already-inactive member is an idempotent no-op; only the
			// first removal is an auditable event.
			const [before] = await db
				.select({ active: UserOrganization.active })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, memberUserId),
						eq(UserOrganization.organizationId, organization.id),
					),
				)
				.limit(1)
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

			// Drop the removed member's open chat sockets right away instead of
			// waiting for the room's ~30s access re-check.
			await notifyChat(organization.id, (room) => room.evictUser(memberUserId))

			// A removed member's Canva grant must not outlive their access: forget
			// it here and revoke it at Canva (best effort; the removal stands).
			try {
				await deleteCanvaConnection({
					userId: memberUserId,
					organization: { id: organization.id },
				})
			} catch (error) {
				console.error(
					'Failed to remove Canva connection of removed member:',
					error instanceof Error ? error.name : 'unknown',
				)
			}

			try {
				await updateSeatQuantity(organization.id)
			} catch (error) {
				console.error(
					'Failed to update seat quantity after removing user:',
					error,
				)
			}

			if (before?.active) {
				await auditMemberRemoved({
					organizationId: organization.id,
					memberUserId,
					actorId: userId,
					request,
				})
				// Removing app access is not terminating the person: the staff record
				// keeps its schedule, PIN and pay history. Only the login link is
				// detached, through the staffing outbox (ids only, best effort now,
				// retried by the daily job).
				try {
					const queued = await enqueueStaffingOutbox({
						organizationId: organization.id,
						kind: 'unlink_user',
						payload: { userId: memberUserId },
					})
					if (queued) {
						await flushStaffingOutboxFor(organization.id, memberUserId)
					}
				} catch (error) {
					console.error(
						'Failed to queue staff unlink after removing member:',
						error instanceof Error ? error.name : 'unknown',
					)
				}
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
		// Role reassignment is limited to the built-in admin role and to location
		// managers (#126), who can only give a role with no permission they lack,
		// to members inside their own locations. A tenant role with
		// UPDATE_MEMBER_ANY must not be able to grant itself more authority.
		const actor = await loadMemberActor(userId, organization.id)
		if (!actor || !(actor.isAdmin || actor.manageOwnLocations)) {
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
		const roleRefusal = await refuseMemberChange(userId, organization.id, {
			action: 'change_role',
			targetUserId: memberUserId,
			roleId: organizationRole.id,
		})
		if (roleRefusal) return roleRefusal

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
			// A role change can alter chat access and moderation rights; make the
			// room re-read them now. The member stays connected.
			await notifyChat(organization.id, (room) => room.invalidate())
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

	// --- update-member-locations intent ---
	if (intent === 'update-member-locations') {
		// Narrowing someone's access is as sensitive as changing their role, so it
		// is limited to admins and to location managers (#126), who can only work
		// inside their own locations. It no longer depends on the Staff module.
		const actor = await loadMemberActor(userId, organization.id)
		if (!actor || !(actor.isAdmin || actor.manageOwnLocations)) {
			return Response.json(
				{ error: 'Only organization admins can change staff locations' },
				{ status: 403 },
			)
		}

		const memberUserId = formData.get('userId')
		if (!memberUserId || typeof memberUserId !== 'string') {
			return Response.json({ error: 'Missing userId' }, { status: 400 })
		}
		if (memberUserId === userId) {
			return Response.json(
				{ error: 'You cannot change your own staff locations' },
				{ status: 400 },
			)
		}
		const parsed = memberLocationScopeInputSchema.safeParse({
			scope: formData.get('scope'),
			locationIds: formData.getAll('locationIds'),
			tagIds: formData.getAll('tagIds'),
		})
		if (!parsed.success) {
			return Response.json(
				{ error: 'Choose all locations or a list of locations' },
				{ status: 400 },
			)
		}

		if (!actor.isAdmin && parsed.data.tagIds.length > 0) {
			// A tag reaches locations added to it later: only admins hand it out.
			return memberCheckResponse({
				ok: false,
				code: 'location_not_in_your_scope',
				status: 403,
				error: 'Only organization admins can give access by tag.',
			})
		}
		const locationRefusal = await refuseMemberChange(userId, organization.id, {
			action: 'change_locations',
			targetUserId: memberUserId,
			scope: parsed.data.scope,
			locationIds: parsed.data.locationIds,
		})
		if (locationRefusal) return locationRefusal

		try {
			const result = await setMemberLocationScope({
				organizationId: organization.id,
				userId: memberUserId,
				value: parsed.data,
			})
			if (!result.ok) {
				return Response.json(
					{
						error:
							result.reason === 'member_not_found'
								? 'Member not found'
								: result.reason === 'unknown_tag'
									? 'One or more tags were not found'
									: 'One or more locations were not found',
					},
					{ status: result.reason === 'member_not_found' ? 404 : 400 },
				)
			}
			await auditMemberLocationsChanged({
				organizationId: organization.id,
				memberUserId,
				actorId: userId,
				previous: result.previous,
				next: result.next,
				request,
			})
			return Response.json({ success: true })
		} catch (error) {
			console.error(
				'Error updating member staff locations:',
				error instanceof Error ? error.name : 'unknown',
			)
			return Response.json(
				{ error: 'Failed to update staff locations' },
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
		const linkRefusal = await refuseScopedInviteLink(userId, organization.id)
		if (linkRefusal) return linkRefusal

		try {
			const inviteLink = await createOrganizationInviteLink({
				organizationId: organization.id,
				roleId: 'org_role_member',
				createdById: userId,
				request,
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
		const linkRefusal = await refuseScopedInviteLink(userId, organization.id)
		if (linkRefusal) return linkRefusal

		try {
			const inviteLink = await createOrganizationInviteLink({
				organizationId: organization.id,
				roleId: 'org_role_member',
				createdById: userId,
				request,
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
			const disabled = await deactivateOrganizationInviteLink(
				organization.id,
				userId,
			)
			if (disabled.length > 0) {
				await auditInviteLinkDisabled({
					organizationId: organization.id,
					actorId: userId,
					request,
				})
			}
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
		staffingLocations,
		memberLocationNames,
		memberScopes,
		manageableUserIds,
		removableUserIds,
		invitableLocationIds,
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
					staffingLocations={staffingLocations}
					locationNames={memberLocationNames}
					memberScopes={memberScopes}
					manageableUserIds={manageableUserIds}
					removableUserIds={removableUserIds}
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
					locationNames={memberLocationNames}
					invitableLocationIds={invitableLocationIds}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}
