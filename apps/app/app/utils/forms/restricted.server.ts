import {
	getUserId,
	ORG_PERMISSIONS,
	userHasOrganizationPermission,
} from '@repo/auth'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type TenantClientOptions = Parameters<typeof getOperatorTenantClient>[2]

/**
 * Whether the signed-in member may read, export and unrestrict the responses
 * of restricted forms (#357). The permission is `read:form_restricted:any`.
 */
export async function memberCanReadRestrictedForms(
	request: Request,
	organizationId: string,
): Promise<boolean> {
	const userId = await getUserId(request)
	if (!userId) return false
	return userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_FORM_RESTRICTED_ANY,
	)
}

/**
 * The operator tenant client for the forms screens and the Mailbox. The signed
 * `restrictedForms` claim is added only for members holding the permission, so
 * the region (not this server) refuses restricted responses to everyone else.
 */
export async function getFormsTenantClient(
	request: Request,
	orgSlug: string,
	organizationId: string,
	options: TenantClientOptions = {},
) {
	const canReadRestricted = await memberCanReadRestrictedForms(
		request,
		organizationId,
	)
	const client = await getOperatorTenantClient(request, orgSlug, {
		...options,
		...(canReadRestricted
			? { claims: { ...options?.claims, restrictedForms: true } }
			: {}),
	})
	return { ...client, canReadRestricted }
}
