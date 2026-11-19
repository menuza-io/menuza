import { requireUserId } from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'

/**
 * Website, Events (#184): a member with the website permission, and 404
 * while `website.events` is off. Every events loader and action calls it
 * first.
 */
export async function requireEventsAccess(
	request: Request,
	orgSlug: string | undefined,
	permission: 'read' | 'update',
) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
		siteLocales: true,
		siteDefaultLocale: true,
		staffingTimeZone: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		permission === 'read'
			? ORG_PERMISSIONS.READ_WEBSITE_ANY
			: ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	if (!(await getLandingFeatures(organization.id)).events) {
		throw new Response('Not Found', { status: 404 })
	}
	return organization
}
