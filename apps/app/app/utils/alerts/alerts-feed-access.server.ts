import { and, db, eq, UserOrganization } from '@repo/database'

/** Whether the user is an active member of the organization (the phone's Alerts tab checks this per request). */
export async function userHasOrganizationAccess(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const row = await db.query.UserOrganization.findFirst({
		where: and(
			eq(UserOrganization.userId, userId),
			eq(UserOrganization.organizationId, organizationId),
			eq(UserOrganization.active, true),
		),
		columns: { userId: true },
	})
	return row !== undefined
}
