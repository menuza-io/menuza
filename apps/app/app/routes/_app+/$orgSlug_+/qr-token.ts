import { data, type LoaderFunctionArgs } from 'react-router'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Short-lived operator token for the browser's direct calls to the regional
 * `/operator/qr/*` routes. `?write=1` needs menu write. The floor-plan import
 * claim is signed only for writers of an org with reservations on; the
 * region reads it fail-closed (only a literal `true`). Deploy App before
 * tenant-api when this token gains a claim.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const write = new URL(request.url).searchParams.get('write') === '1'
	const access = await requireQrOrderingAccess(request, params.orgSlug, {
		write,
	})
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		access.organization.slug,
		{
			scope: write ? 'qr:write' : 'qr:read',
			...(write && access.floorPlanAvailable
				? { claims: { canImportFloorPlan: true } }
				: {}),
		},
	)
	return data(
		{ jwt, tenantApiUrl },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
