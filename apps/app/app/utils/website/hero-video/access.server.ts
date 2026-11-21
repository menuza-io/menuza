import { requireUserId } from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { heroVideoEnabled } from './service.server.ts'

/**
 * Website, hero video (#301): a member with the website permission, and 404
 * while `website.hero_video` is off. Every hero video loader and action calls
 * it first.
 */
export async function requireHeroVideoAccess(
	request: Request,
	orgSlug: string | undefined,
	permission: 'read' | 'update',
) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		permission === 'read'
			? ORG_PERMISSIONS.READ_WEBSITE_ANY
			: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	if (!(await heroVideoEnabled(organization.id))) {
		throw new Response('Not Found', { status: 404 })
	}
	return organization
}
