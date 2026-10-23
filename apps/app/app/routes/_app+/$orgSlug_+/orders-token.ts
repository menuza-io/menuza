import { data, type LoaderFunctionArgs } from 'react-router'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getStationAppGrants } from '#app/utils/pos/station-apps.server.ts'
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
	// Signed claims say which person pages this member may open, so the
	// regional API returns a `customerKey` only when the link will work.
	const link = await getOrderCustomerLinkAccess(request, params.orgSlug || '')
	// Which Station apps this member may switch on for a terminal: each needs its
	// own module's settings permission, not only the menu one.
	const stationApps =
		scope === 'orders:write'
			? await getStationAppGrants(request, organization.id)
			: null
	const claims = {
		...(link.linkCustomers || link.linkGuests ? link : {}),
		...(stationApps && (stationApps.timeclock || stationApps.reservations)
			? { stationApps }
			: {}),
	}
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{
			scope,
			...(Object.keys(claims).length > 0 ? { claims } : {}),
		},
	)
	return data(
		{ jwt, tenantApiUrl },
		{
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}
