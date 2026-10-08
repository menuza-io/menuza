import {
	getUserId,
	type OrganizationPermissionString,
	userHasOrganizationPermission,
} from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

async function requirePhoneAgentOrganization(
	request: Request,
	orgSlug: string | undefined,
) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		name: true,
		dataRegion: true,
	})
	return {
		orgId: organization.id!,
		orgName: organization.name ?? '',
		dataRegion: organization.dataRegion ?? 'us',
	}
}

export async function requirePhoneAgentAccess(
	request: Request,
	orgSlug: string | undefined,
	permission: OrganizationPermissionString = ORG_PERMISSIONS.READ_PHONE_AGENT_ANY,
) {
	const organization = await requirePhoneAgentOrganization(request, orgSlug)
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.orgId,
		permission,
	)
	return { ...organization, userId }
}

async function hasPermission(
	request: Request,
	orgId: string,
	permission: OrganizationPermissionString,
) {
	const userId = await getUserId(request)
	if (!userId) return false
	return userHasOrganizationPermission(userId, orgId, permission)
}

/** The phone agent section is open to people who can see the setup or calls. */
export async function requirePhoneAgentSectionAccess(
	request: Request,
	orgSlug: string | undefined,
) {
	const organization = await requirePhoneAgentOrganization(request, orgSlug)
	await requireAnyUserWithOrganizationPermission(request, organization.orgId, [
		ORG_PERMISSIONS.READ_PHONE_AGENT_ANY,
		ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
	])
	const [canReadAgent, canReadCalls] = await Promise.all([
		hasPermission(
			request,
			organization.orgId,
			ORG_PERMISSIONS.READ_PHONE_AGENT_ANY,
		),
		hasPermission(
			request,
			organization.orgId,
			ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
		),
	])
	return { ...organization, canReadAgent, canReadCalls }
}

export async function canUpdatePhoneAgent(request: Request, orgId: string) {
	return hasPermission(request, orgId, ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY)
}

export async function canReadPhoneCalls(request: Request, orgId: string) {
	return hasPermission(request, orgId, ORG_PERMISSIONS.READ_PHONE_CALL_ANY)
}

/**
 * What the user may do with call data beyond viewing it. Following up
 * (completing, reopening, tagging) and deleting are separate permissions.
 */
export async function getPhoneCallPermissions(request: Request, orgId: string) {
	const [canUpdate, canDelete] = await Promise.all([
		hasPermission(request, orgId, ORG_PERMISSIONS.UPDATE_PHONE_CALL_ANY),
		hasPermission(request, orgId, ORG_PERMISSIONS.DELETE_PHONE_CALL_ANY),
	])
	return { canUpdate, canDelete }
}
