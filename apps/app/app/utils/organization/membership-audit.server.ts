import { AuditAction, auditService } from '@repo/audit'

export type MemberAddedVia = 'invitation' | 'invite_link' | 'verified_domain'

type AuditMetadata = Record<
	string,
	string | number | boolean | null | undefined
>

async function safeLog(input: Parameters<typeof auditService.log>[0]) {
	try {
		await auditService.log(input)
	} catch (error) {
		// Auditing must never block a membership change that already happened.
		console.error(`Failed to write audit log ${input.action}:`, error)
	}
}

export async function auditMemberAdded({
	organizationId,
	memberUserId,
	actorId = memberUserId,
	via,
	roleId,
	request,
	metadata,
}: {
	organizationId: string
	memberUserId: string
	/** Who caused the change; defaults to the member themselves (self-join). */
	actorId?: string
	via: MemberAddedVia
	roleId?: string | null
	request?: Request
	metadata?: AuditMetadata
}) {
	await safeLog({
		action: AuditAction.ORG_MEMBER_ADDED,
		userId: actorId,
		targetUserId: memberUserId,
		organizationId,
		resourceType: 'organization_member',
		resourceId: memberUserId,
		details: 'Organization member added',
		metadata: { via, roleId, ...metadata },
		request,
	})
}

export async function auditMemberRemoved({
	organizationId,
	memberUserId,
	actorId,
	request,
}: {
	organizationId: string
	memberUserId: string
	actorId: string
	request?: Request
}) {
	await safeLog({
		action: AuditAction.ORG_MEMBER_REMOVED,
		userId: actorId,
		targetUserId: memberUserId,
		organizationId,
		resourceType: 'organization_member',
		resourceId: memberUserId,
		details: 'Organization member removed',
		metadata: { deactivated: true },
		request,
	})
}

export async function auditInvitationSent({
	organizationId,
	actorId,
	invitationId,
	invitedEmail,
	roleId,
	isResend,
	request,
}: {
	organizationId: string
	actorId: string
	invitationId: string
	invitedEmail: string
	roleId: string
	isResend: boolean
	request?: Request
}) {
	await safeLog({
		action: AuditAction.ORG_INVITATION_SENT,
		userId: actorId,
		organizationId,
		resourceType: 'organization_invitation',
		resourceId: invitationId,
		details: 'Organization invitation sent',
		metadata: { invitedEmail, roleId, isResend },
		request,
	})
}

export async function auditInvitationAccepted({
	organizationId,
	userId,
	invitationId,
	roleId,
	inviterId,
	alreadyMember,
}: {
	organizationId: string
	userId: string
	invitationId: string
	roleId: string
	inviterId?: string | null
	alreadyMember: boolean
}) {
	await safeLog({
		action: AuditAction.ORG_INVITATION_ACCEPTED,
		userId,
		targetUserId: userId,
		organizationId,
		resourceType: 'organization_invitation',
		resourceId: invitationId,
		details: 'Organization invitation accepted',
		metadata: { roleId, inviterId, alreadyMember },
	})
}

export async function auditInvitationRevoked({
	organizationId,
	actorId,
	invitationId,
	request,
}: {
	organizationId: string
	actorId: string
	invitationId: string
	request?: Request
}) {
	await safeLog({
		action: AuditAction.ORG_INVITATION_REVOKED,
		userId: actorId,
		organizationId,
		resourceType: 'organization_invitation',
		resourceId: invitationId,
		details: 'Organization invitation revoked',
		request,
	})
}

export async function auditInviteLinkCreated({
	organizationId,
	actorId,
	linkId,
	roleId,
	regenerated,
	request,
}: {
	organizationId: string
	actorId: string
	linkId?: string
	roleId?: string
	/** True when an existing link's token was rotated instead of a first create. */
	regenerated: boolean
	request?: Request
}) {
	await safeLog({
		action: AuditAction.ORG_INVITE_LINK_CREATED,
		userId: actorId,
		organizationId,
		resourceType: 'organization_invite_link',
		resourceId: linkId,
		details: regenerated
			? 'Organization invite link regenerated'
			: 'Organization invite link created',
		metadata: { roleId, regenerated },
		request,
	})
}

export async function auditInviteLinkDisabled({
	organizationId,
	actorId,
	request,
}: {
	organizationId: string
	actorId: string
	request?: Request
}) {
	await safeLog({
		action: AuditAction.ORG_INVITE_LINK_DISABLED,
		userId: actorId,
		organizationId,
		resourceType: 'organization_invite_link',
		details: 'Organization invite link disabled',
		request,
	})
}

export async function auditMemberLocationsChanged({
	organizationId,
	memberUserId,
	actorId,
	previous,
	next,
	request,
}: {
	organizationId: string
	memberUserId: string
	actorId: string
	previous: { scope: string; locationIds: readonly string[] }
	next: { scope: string; locationIds: readonly string[] }
	request?: Request
}) {
	// Ids only: location ids are control-plane identifiers, never staff data.
	await safeLog({
		action: AuditAction.ORG_MEMBER_LOCATIONS_CHANGED,
		userId: actorId,
		targetUserId: memberUserId,
		organizationId,
		resourceType: 'organization_member',
		resourceId: memberUserId,
		details: 'Organization member staffing locations changed',
		metadata: {
			oldScope: previous.scope,
			oldLocationIds: previous.locationIds.join(','),
			newScope: next.scope,
			newLocationIds: next.locationIds.join(','),
		},
		request,
	})
}
