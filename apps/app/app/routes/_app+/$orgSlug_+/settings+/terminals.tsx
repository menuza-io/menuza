import { userHasOrganizationPermission } from '@repo/auth'
import { data, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ENV } from 'varlock/env'
import { PosDayReport } from '#app/components/pos/pos-day-report.tsx'
import { TerminalsManager } from '#app/components/pos/terminals-manager.tsx'
import { ZatcaSettings } from '#app/components/pos/zatca-settings.tsx'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { resolvePosUrl } from '#app/utils/pos/url.server.ts'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import { getStaffingFeatureState } from '#app/utils/staffing/access.server.ts'
import { listScopableLocations } from '#app/utils/staffing/restaurant/location-scope.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	const userId = await requireMenuRead(request, organization.id)
	const [canWrite, locations, staffing, reservations] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_MENU_ANY,
		),
		listScopableLocations(organization.id),
		getStaffingFeatureState(organization.id),
		getReservationsFeatureState(organization.id),
	])
	return data(
		{
			// A terminal bound to a location sells there and can run its host stand.
			locations,
			// Station apps a terminal can offer, as the organization has them.
			stationFeatures: {
				timeclock: staffing.timeclock,
				reservations: reservations.enabled,
			},
			orgSlug: params.orgSlug || '',
			canWrite,
			posUrl: resolvePosUrl(ENV.POS_URL, process.env.NODE_ENV),
			// The origin the terminal reads the menu and branding from: the
			// canonical App origin, never the Host the request happened to use.
			appUrl: new URL(ENV.BASE_URL).origin,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function TerminalsPage() {
	const { orgSlug, canWrite, posUrl, appUrl, locations, stationFeatures } =
		useLoaderData<typeof loader>()
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<TerminalsManager
				orgSlug={orgSlug}
				canWrite={canWrite}
				posUrl={posUrl}
				appUrl={appUrl}
				locations={locations}
				stationFeatures={stationFeatures}
			/>
			<PosDayReport orgSlug={orgSlug} />
			<ZatcaSettings orgSlug={orgSlug} canWrite={canWrite} />
		</div>
	)
}
