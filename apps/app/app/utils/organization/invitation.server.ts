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
	OrganizationInvitationLocation,
	OrganizationLocation,
	OrganizationInviteLink,
	OrganizationRole,
	User,
	UserOrganization,
} from '@repo/database'
import { OrganizationInviteEmail, sendEmail } from '@repo/email'
import { opaqueIdSchema } from '@repo/staffing'
import { type SQL } from 'drizzle-orm'
import { updateSeatQuantity } from '#app/utils/payments.server.ts'
import {
	enqueueStaffingOutbox,
	flushStaffingOutboxFor,
} from '#app/utils/staffing/outbox.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import { MAX_ORGANIZATION_INVITES_PER_REQUEST } from './invitation.ts'
import {
	assertCanManageMember,
	loadMemberActor,
	memberCheckResponse,
} from './member-management.server.ts'
import {
	auditInvitationAccepted,
	auditInvitationSent,
	auditInviteLinkCreated,
	auditMemberAdded,
} from './membership-audit.server.ts'
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

export type InvitationLocations = {
	/** 'all' (every location, the default) or 'selected' (only `locationIds`). */
	locationScope?: 'all' | 'selected'
	locationIds?: readonly string[]
}

/** Locations of this organization among the ids; a crafted id is refused. */
async function requireOrganizationLocations(
	organizationId: string,
	locationIds: readonly string[],
) {
	const owned = new Set(
		(
			await db
				.select({ id: OrganizationLocation.id })
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, organizationId))
		).map((row) => row.id),
	)
	invariantResponse(
		locationIds.every((id) => owned.has(id)),
		'One or more locations were not found',
		{ status: 400 },
	)
}

function normalizeLocations(input: InvitationLocations) {
	const locationScope = input.locationScope ?? 'all'
	const locationIds = [...new Set(input.locationIds ?? [])]
	invariantResponse(
		locationScope === 'all' || locationIds.length > 0,
		'Choose at least one location',
		{ status: 400 },
	)
	return {
		locationScope,
		locationIds: locationScope === 'all' ? [] : locationIds,
	}
}

/**
 * Refuses an invitation the inviter may not send (#126): Admin or any role with
 * a permission they lack, and any location outside their own scope. An
 * organization admin is unrestricted.
 */
async function requireInviteAllowed({
	organizationId,
	inviterId,
	roleId,
	locations,
}: {
	organizationId: string
	inviterId: string
	roleId: string
	locations: ReturnType<typeof normalizeLocations>
}) {
	const actor = await loadMemberActor(inviterId, organizationId)
	invariantResponse(actor, 'You are not a member of this organization', {
		status: 403,
	})
	const check = await assertCanManageMember(actor, {
		action: 'invite',
		roleId,
		scope: locations.locationScope,
		locationIds: locations.locationIds,
	})
	if (!check.ok) throw memberCheckResponse(check)
}

export async function validateOrganizationInviteRoles(
	organizationId: string,
	invites: Array<{ roleId?: string; role?: OrganizationRoleName }>,
	inviterId: string,
	inviteLocations: InvitationLocations = {},
) {
	const locations = normalizeLocations(inviteLocations)
	await requireOrganizationLocations(organizationId, locations.locationIds)
	const organizationRoles = await Promise.all(
		invites.map((invite) =>
			getAssignableOrganizationRole({
				organizationId,
				roleId: invite.roleId,
				roleName: invite.role,
			}),
		),
	)
	for (const role of organizationRoles) {
		await requireInviteAllowed({
			organizationId,
			inviterId,
			roleId: role.id,
			locations,
		})
	}
}

export async function createOrganizationInvitation({
	organizationId,
	email: rawEmail,
	role = 'member',
	roleId,
	inviterId,
	staffMemberId,
	request,
	locationScope: requestedScope,
	locationIds: requestedLocationIds,
}: InvitationLocations & {
	organizationId: string
	email: string
	role?: OrganizationRoleName
	roleId?: string
	inviterId: string
	/**
	 * Opaque id of the regional staff record this invitation is for. When the
	 * invitee accepts, their login is linked to that record (see
	 * `acceptInvitation`). Omitted on a re-invite, an existing link is kept.
	 */
	staffMemberId?: string
	request?: Request
}) {
	invariantResponse(
		staffMemberId === undefined ||
			opaqueIdSchema.safeParse(staffMemberId).success,
		'Invalid staff member id',
		{ status: 400 },
	)
	const email = rawEmail.toLowerCase().trim()
	const token = crypto.randomUUID()
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
	const organizationRole = await getAssignableOrganizationRole({
		organizationId,
		roleId,
		roleName: role,
	})
	const locations = normalizeLocations({
		locationScope: requestedScope,
		locationIds: requestedLocationIds,
	})
	await requireOrganizationLocations(organizationId, locations.locationIds)
	await requireInviteAllowed({
		organizationId,
		inviterId,
		roleId: organizationRole.id,
		locations,
	})
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
			locationScope: locations.locationScope,
			...(staffMemberId ? { staffMemberId } : {}),
		})
		.onConflictDoUpdate({
			target: [
				OrganizationInvitation.email,
				OrganizationInvitation.organizationId,
			],
			set: {
				token,
				organizationRoleId,
				expiresAt,
				inviterId,
				locationScope: locations.locationScope,
				...(staffMemberId ? { staffMemberId } : {}),
			},
		})
	const invitation = await getInvitationByToken(token)
	if (!invitation) throw new Error('Failed to create invitation')
	// A re-invite replaces the locations of the earlier one.
	await db
		.delete(OrganizationInvitationLocation)
		.where(eq(OrganizationInvitationLocation.invitationId, invitation.id))
	// 3 bound values per row on D1, which allows 100 per statement.
	for (let i = 0; i < locations.locationIds.length; i += 30) {
		await db.insert(OrganizationInvitationLocation).values(
			locations.locationIds.slice(i, i + 30).map((locationId) => ({
				invitationId: invitation.id,
				locationId,
			})),
		)
	}
	if (!existing) {
		await markStepCompleted(inviterId, organizationId, 'invite_members', {
			completedVia: 'member_invitation',
			invitedEmail: email,
			role: invitation.organizationRole.name,
		})
	}
	await auditInvitationSent({
		organizationId,
		actorId: inviterId,
		invitationId: invitation.id,
		invitedEmail: email,
		roleId: organizationRoleId,
		isResend: !!existing,
		locationScope: locations.locationScope,
		locationIds: locations.locationIds,
		request,
	})
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
	const locationRows = await db
		.select({
			invitationId: OrganizationInvitationLocation.invitationId,
			locationId: OrganizationInvitationLocation.locationId,
		})
		.from(OrganizationInvitationLocation)
		.innerJoin(
			OrganizationInvitation,
			eq(
				OrganizationInvitation.id,
				OrganizationInvitationLocation.invitationId,
			),
		)
		.where(eq(OrganizationInvitation.organizationId, organizationId))
	const byInvitation = new Map<string, string[]>()
	for (const row of locationRows) {
		byInvitation.set(row.invitationId, [
			...(byInvitation.get(row.invitationId) ?? []),
			row.locationId,
		])
	}
	return rows.map((row) => {
		const locationIds = (byInvitation.get(row.invitation.id) ?? []).sort()
		return {
			...row.invitation,
			organizationRole: row.organizationRole,
			inviter: row.inviter,
			locationIds,
			// Chosen locations that were all deleted: the invitation is void.
			hasNoLocations:
				row.invitation.locationScope !== 'all' && locationIds.length === 0,
		}
	})
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
		.returning({ id: OrganizationInvitation.id })
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
		| 'id'
		| 'email'
		| 'organizationId'
		| 'organizationRoleId'
		| 'organization'
		| 'inviterId'
		| 'staffMemberId'
		| 'locationScope'
	>,
	userId: string,
) {
	await assertInvitationOwnedByUser(invitation, userId)
	// The locations the invitation grants, read now: a location deleted since
	// the invitation was sent is gone from it, and one with none left is void.
	const grantedLocations =
		invitation.locationScope === 'all'
			? null
			: (
					await db
						.select({ locationId: OrganizationInvitationLocation.locationId })
						.from(OrganizationInvitationLocation)
						.where(
							eq(OrganizationInvitationLocation.invitationId, invitation.id),
						)
				).map((row) => row.locationId)
	if (grantedLocations !== null && grantedLocations.length === 0) {
		throw new Response('invitation_has_no_locations', {
			status: 409,
			statusText: 'invitation_has_no_locations',
		})
	}
	const [member] = await db
		.select({
			userId: UserOrganization.userId,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, invitation.organizationId),
			),
		)
		.limit(1)
	if (!member) {
		await db
			.insert(UserOrganization)
			.values({
				userId,
				organizationId: invitation.organizationId,
				organizationRoleId: invitation.organizationRoleId,
				active: true,
				// An invitation for chosen locations starts closed (a selected scope
				// with no grants reaches nothing) and opens to exactly those.
				...(grantedLocations ? { locationScope: 'selected' } : {}),
			})
			.onConflictDoNothing()
		if (grantedLocations) {
			const granted = await setMemberLocationScope({
				organizationId: invitation.organizationId,
				userId,
				value: { scope: 'selected', locationIds: grantedLocations },
			})
			if (!granted.ok) {
				// Fail closed: the member exists with no locations, never with all.
				console.error('Failed to apply invitation locations:', granted.reason)
			}
		}
	}
	await db
		.delete(OrganizationInvitation)
		.where(eq(OrganizationInvitation.id, invitation.id))
	// A failed Stripe write is fixed by the daily seat reconcile job.
	if (!member)
		await updateSeatQuantity(invitation.organizationId).catch((error) =>
			console.error(
				`Failed to update seat quantity for organization ${invitation.organizationId}:`,
				error,
			),
		)
	await auditInvitationAccepted({
		organizationId: invitation.organizationId,
		userId,
		invitationId: invitation.id,
		roleId: invitation.organizationRoleId,
		inviterId: invitation.inviterId,
		alreadyMember: !!member,
	})
	if (!member)
		await auditMemberAdded({
			organizationId: invitation.organizationId,
			memberUserId: userId,
			via: 'invitation',
			roleId: invitation.organizationRoleId,
			metadata: { invitationId: invitation.id },
		})
	// An invitation sent from a staff profile carries the staff record's id.
	// Linking is a staff-data event, so it goes through the outbox to the
	// regional database (ids only), never inline. A member who was removed
	// earlier and is still inactive gets no link.
	if (invitation.staffMemberId && (!member || member.active)) {
		try {
			const queued = await enqueueStaffingOutbox({
				organizationId: invitation.organizationId,
				kind: 'link_user',
				payload: { staffMemberId: invitation.staffMemberId, userId },
			})
			if (queued) {
				await flushStaffingOutboxFor(invitation.organizationId, userId)
			}
		} catch (error) {
			// Accepting the invitation already succeeded; never fail it over a link.
			console.error(
				'Failed to queue staff link after accepting invitation:',
				error instanceof Error ? error.name : 'unknown',
			)
		}
	}
	return { organization: invitation.organization, alreadyMember: !!member }
}

function isVoidInvitation(error: unknown) {
	return (
		error instanceof Response &&
		error.status === 409 &&
		error.statusText === 'invitation_has_no_locations'
	)
}

export async function acceptInvitationByEmail(email: string, userId: string) {
	const invitations = await getPendingInvitationsByEmail(email)
	const results = []
	for (const invitation of invitations) {
		try {
			results.push(await acceptInvitation(invitation, userId))
		} catch (error) {
			// An invitation whose locations were all deleted is void; it must not
			// stop the person's other invitations from being accepted.
			if (isVoidInvitation(error)) continue
			throw error
		}
	}
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
	request,
}: {
	organizationId: string
	role?: OrganizationRoleName
	roleId?: string
	createdById: string
	request?: Request
}) {
	const token = crypto.randomUUID()
	const organizationRoleId = (
		await getAssignableOrganizationRole({
			organizationId,
			roleId,
			roleName: role,
		})
	).id
	const [existingLink] = await db
		.select({ id: OrganizationInviteLink.id })
		.from(OrganizationInviteLink)
		.where(
			and(
				eq(OrganizationInviteLink.organizationId, organizationId),
				eq(OrganizationInviteLink.createdById, createdById),
			),
		)
		.limit(1)
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
	if (link)
		await auditInviteLinkCreated({
			organizationId,
			actorId: createdById,
			linkId: link.link.id,
			roleId: organizationRoleId,
			regenerated: !!existingLink,
			request,
		})
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
				eq(OrganizationInviteLink.isActive, true),
			),
		)
		.returning({ id: OrganizationInviteLink.id })
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
				// A shareable link must never inherit a staff link from the expired
				// invitation it replaces: that would attach a stranger to a record.
				staffMemberId: null,
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
		// A failed Stripe write is fixed by the daily seat reconcile job.
		await updateSeatQuantity(link.organizationId).catch((error) =>
			console.error(
				`Failed to update seat quantity for organization ${link.organizationId}:`,
				error,
			),
		)
		await auditMemberAdded({
			organizationId: link.organizationId,
			memberUserId: userId,
			via: 'invite_link',
			roleId: link.organizationRoleId,
			metadata: { inviteLinkId: link.id, linkCreatedById: link.createdById },
		})
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
