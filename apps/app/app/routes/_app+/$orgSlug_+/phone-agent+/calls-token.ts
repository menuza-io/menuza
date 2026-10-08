import { data } from 'react-router'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	getPhoneCallPermissions,
	requirePhoneAgentAccess,
} from '#app/utils/phone-agent/access.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/calls-token.ts'

/**
 * Call logs hold caller PII, so they live in the regional tenant-api. App only
 * mints the short-lived operator token; the browser fetches the data directly.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const { orgId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
	)
	const { canUpdate, canDelete } = await getPhoneCallPermissions(request, orgId)
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{ scope: 'phone_calls', canUpdate, canDelete },
	)
	return data(
		{ jwt, tenantApiUrl },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
