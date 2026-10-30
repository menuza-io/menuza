import { getUserId, userHasOrganizationPermission } from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

/**
 * Social posting access: reading the calendar needs the marketing (campaign)
 * read permission; connecting accounts and writing, scheduling or deleting
 * posts needs the campaign write permission.
 */

export type SocialAccess = {
	userId: string
	organization: { id: string; slug: string; name: string }
	canWrite: boolean
}

export async function requireSocialAccess(
	request: Request,
	orgSlug: string | undefined,
	options: { write?: boolean } = {},
): Promise<SocialAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	const [canRead, canWrite] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		),
	])
	if (!canRead) throw new Response('Forbidden', { status: 403 })
	if (options.write && !canWrite) {
		throw new Response('Forbidden', { status: 403 })
	}
	return {
		userId,
		organization: organization as SocialAccess['organization'],
		canWrite,
	}
}
