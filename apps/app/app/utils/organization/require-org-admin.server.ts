import { requireUserId } from '@repo/auth'
import { and, db, eq, UserOrganization } from '@repo/database'

/**
 * Ensures the signed-in user is an active admin of the organization.
 */
export async function requireOrganizationAdmin(
	request: Request,
	organizationId: string,
): Promise<void> {
	const userId = await requireUserId(request)
	const [membership] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
				eq(UserOrganization.organizationRoleId, 'org_role_admin'),
			),
		)
		.limit(1)

	if (!membership) {
		throw new Response('Forbidden', { status: 403 })
	}
}
