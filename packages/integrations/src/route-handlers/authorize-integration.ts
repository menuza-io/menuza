import { Integration as IntegrationTable, db, eq } from '@repo/database'
import { type Integration } from '../database-types'

type OrganizationPermission = `${string}:${string}:${string}`

/**
 * How the integration API routes authorize a request. They check the member
 * against the organization that owns the integration the request names, never
 * against the member's default organization, so someone in several
 * organizations can manage each one's integrations.
 */
export interface IntegrationRouteAuthDependencies {
	requireUserId: (request: Request) => Promise<string>
	/** Whether the user is an active member of the organization. */
	isOrganizationMember: (
		userId: string,
		organizationId: string,
	) => Promise<boolean>
	/** Throws (a 403 Response) unless the member has the permission. */
	requireOrgPermission: (
		request: Request,
		organizationId: string,
		permission: OrganizationPermission,
	) => Promise<void>
}

/**
 * Loads an integration by id for a signed-in user. A missing integration and
 * one in an organization the user does not belong to both read as 404, so an
 * id reveals nothing; a member without the permission gets 403.
 */
export async function authorizeIntegration(
	request: Request,
	userId: string,
	integrationId: string,
	deps: IntegrationRouteAuthDependencies,
	permission: OrganizationPermission,
): Promise<{ integration: Integration } | { status: 403 | 404 }> {
	const [integration] = await db
		.select()
		.from(IntegrationTable)
		.where(eq(IntegrationTable.id, integrationId))
		.limit(1)

	if (
		!integration ||
		!(await deps.isOrganizationMember(userId, integration.organizationId))
	) {
		return { status: 404 }
	}

	try {
		await deps.requireOrgPermission(
			request,
			integration.organizationId,
			permission,
		)
	} catch {
		return { status: 403 }
	}

	return { integration }
}
