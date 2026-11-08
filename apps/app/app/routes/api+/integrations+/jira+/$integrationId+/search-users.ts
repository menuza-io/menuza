import { requireUserId } from '@repo/auth'
import { handleJiraSearchUsers } from '@repo/integrations'
import { type LoaderFunctionArgs } from 'react-router'
import { isActiveOrganizationMember } from '#app/utils/org-membership.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

/**
 * API endpoint to search for Jira users
 * Used by the bot user configuration UI
 */
export async function loader(args: LoaderFunctionArgs) {
	return handleJiraSearchUsers(args, {
		requireUserId,
		// The integration's own organization, not the member's default one.
		isOrganizationMember: isActiveOrganizationMember,
		requireOrgPermission: async (request, organizationId, permission) => {
			await requireUserWithOrganizationPermission(
				request,
				organizationId,
				permission,
			)
		},
	})
}
