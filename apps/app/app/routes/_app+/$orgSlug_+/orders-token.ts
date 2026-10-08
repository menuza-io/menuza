import { data, type LoaderFunctionArgs } from 'react-router'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const scope =
		new URL(request.url).searchParams.get('write') === '1'
			? 'orders:write'
			: 'orders:read'
	if (scope === 'orders:write') await requireMenuWrite(request, organization.id)
	else await requireMenuRead(request, organization.id)
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{ scope },
	)
	return data(
		{ jwt, tenantApiUrl },
		{
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}
