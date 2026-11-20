import { data, type LoaderFunctionArgs } from 'react-router'
import { getFormsTenantClient } from '#app/utils/forms/restricted.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	// The token carries `restrictedForms` only for members holding
	// `read:form_restricted:any`; the region filters restricted forms by it (#357).
	const { jwt, tenantApiUrl, canReadRestricted } = await getFormsTenantClient(
		request,
		params.orgSlug || '',
		organization.id,
		{ scope: 'mailbox' },
	)
	return data(
		{ jwt, tenantApiUrl, canReadRestricted },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
