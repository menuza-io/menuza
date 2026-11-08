import { AuditAction, auditService } from '@repo/audit'
import { and, db, eq, SSOConfiguration, SSOIdentity } from '@repo/database'

export type ResetSSOLinkResult =
	{ status: 'reset' } | { status: 'not_configured' } | { status: 'not_linked' }

/**
 * Removes the link between one user and their account at the organization's
 * identity provider. Their next SSO sign-in links them again by email (on an
 * allowed domain), for example after the IdP user was recreated or the
 * organization moved to a new app registration. Audited.
 */
export async function resetSSOIdentityLink({
	organizationId,
	userId,
	adminUserId,
	request,
}: {
	organizationId: string
	userId: string
	adminUserId: string
	request?: Request
}): Promise<ResetSSOLinkResult> {
	const [config] = await db
		.select({ id: SSOConfiguration.id })
		.from(SSOConfiguration)
		.where(eq(SSOConfiguration.organizationId, organizationId))
		.limit(1)
	if (!config) return { status: 'not_configured' }

	const removed = await db
		.delete(SSOIdentity)
		.where(
			and(
				eq(SSOIdentity.ssoConfigId, config.id),
				eq(SSOIdentity.userId, userId),
			),
		)
		.returning({ id: SSOIdentity.id })
	if (removed.length === 0) return { status: 'not_linked' }

	await auditService.log({
		action: AuditAction.SSO_IDENTITY_LINK_RESET,
		userId: adminUserId,
		organizationId,
		targetUserId: userId,
		resourceType: 'sso_identity',
		resourceId: config.id,
		details:
			'SSO link reset by a platform admin. The user is linked again on their next SSO sign-in.',
		metadata: { ssoConfigId: config.id },
		request,
	})
	return { status: 'reset' }
}
