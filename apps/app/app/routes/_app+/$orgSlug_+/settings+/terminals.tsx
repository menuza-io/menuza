import { isImpersonating, userHasOrganizationPermission } from '@repo/auth'
import { cashDiscountAllowedIn } from '@repo/common/cash-discount'
import {
	getLocationCurrency,
	type LocationAddress,
} from '@repo/common/location-types'
import { parsePosLocationStationSettings } from '@repo/common/pos-orders'
import { and, asc, db, eq, OrganizationLocation } from '@repo/database'
import { data, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { ENV } from 'varlock/env'
import { PosDayReport } from '#app/components/pos/pos-day-report.tsx'
import { ReadyTextSettings } from '#app/components/pos/ready-text-settings.tsx'
import { StationRegisterSettings } from '#app/components/pos/station-register-settings.tsx'
import { TerminalsManager } from '#app/components/pos/terminals-manager.tsx'
import { ZatcaSettings } from '#app/components/pos/zatca-settings.tsx'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { getStationAppGrants } from '#app/utils/pos/station-apps.server.ts'
import { resolvePosUrl } from '#app/utils/pos/url.server.ts'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import { getStaffingFeatureState } from '#app/utils/staffing/access.server.ts'
import { listScopableLocations } from '#app/utils/staffing/restaurant/location-scope.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true, dataRegion: true },
	)
	const userId = await requireMenuRead(request, organization.id)
	const [
		canWrite,
		hasShiftClose,
		impersonating,
		locations,
		staffing,
		reservations,
		inventory,
		locationRows,
	] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_MENU_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_POS_SHIFT_ANY,
		),
		isImpersonating(request),
		listScopableLocations(organization.id),
		getStaffingFeatureState(organization.id),
		getReservationsFeatureState(organization.id),
		getInventoryFeatureState(organization.id),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				address: OrganizationLocation.address,
				enabled: OrganizationLocation.readyTextEnabled,
				stationSettings: OrganizationLocation.stationSettings,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organization.id!),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.name)),
	])
	const canCloseShifts = hasShiftClose && !impersonating
	const readyText = locationRows.map((row) => ({
		id: row.id,
		name: row.name,
		enabled: row.enabled,
	}))
	const registerLocations = locationRows.map((row) => {
		let parsedAddress: LocationAddress | null = null
		if (row.address) {
			try {
				parsedAddress = JSON.parse(row.address) as LocationAddress
			} catch {
				parsedAddress = null
			}
		}
		return {
			id: row.id,
			name: row.name,
			currency:
				organization.dataRegion === 'ksa'
					? 'SAR'
					: getLocationCurrency(parsedAddress),
			settings: parsePosLocationStationSettings(row.stationSettings),
		}
	})
	return data(
		{
			// A terminal bound to a location sells there and can run its host stand.
			locations,
			// Station apps a terminal can offer, as the organization has them.
			stationFeatures: {
				timeclock: staffing.timeclock,
				reservations: reservations.enabled,
				inventory: inventory.enabled,
			},
			// Whether this member may switch each one on (its own module's setting).
			stationGrants: await getStationAppGrants(request, organization.id),
			// "Text guests when their order is ready": policy per location, US only.
			readyText: {
				smsAvailable: organization.dataRegion === 'us',
				locations: readyText,
			},
			registerLocations,
			// The cash-payment discount (#375) is offered only where the
			// organization's data region allows it.
			cashDiscountAllowed: cashDiscountAllowedIn(organization.dataRegion),
			orgSlug: params.orgSlug || '',
			canWrite,
			canCloseShifts,
			posUrl: resolvePosUrl(ENV.POS_URL, process.env.NODE_ENV),
			// The origin the terminal reads the menu and branding from: the
			// canonical App origin, never the Host the request happened to use.
			appUrl: new URL(ENV.BASE_URL).origin,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function TerminalsPage() {
	const {
		orgSlug,
		canWrite,
		canCloseShifts,
		posUrl,
		appUrl,
		locations,
		stationFeatures,
		stationGrants,
		readyText,
		registerLocations,
		cashDiscountAllowed,
	} = useLoaderData<typeof loader>()
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<TerminalsManager
				orgSlug={orgSlug}
				canWrite={canWrite}
				posUrl={posUrl}
				appUrl={appUrl}
				locations={locations}
				stationFeatures={stationFeatures}
				stationGrants={stationGrants}
			/>
			<StationRegisterSettings
				orgSlug={orgSlug}
				canWrite={canWrite}
				locations={registerLocations}
				cashDiscountAllowed={cashDiscountAllowed}
			/>
			<ReadyTextSettings
				orgSlug={orgSlug}
				canWrite={canWrite}
				smsAvailable={readyText.smsAvailable}
				locations={readyText.locations}
			/>
			<PosDayReport orgSlug={orgSlug} canCloseShifts={canCloseShifts} />
			<ZatcaSettings orgSlug={orgSlug} canWrite={canWrite} />
		</div>
	)
}
