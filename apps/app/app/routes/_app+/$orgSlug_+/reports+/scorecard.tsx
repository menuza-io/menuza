import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import {
	buildLocationScorecard,
	rankLocations,
	type LocationScorecardEntry,
} from '@repo/common/location-scorecard'
import { and, asc, db, eq, inArray, OrganizationLocation } from '@repo/database'
import { WorkspacePage } from '@repo/ui/workspace'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getReportSalesBasis } from '#app/utils/reports/sales-basis.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/scorecard.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
	})
	const [salesBasis, locationIds] = await Promise.all([
		getReportSalesBasis(userId, organization.id),
		resolveReservationsLocationIds(userId, organization.id),
	])
	const locationFilter =
		locationIds === null
			? eq(OrganizationLocation.organizationId, organization.id)
			: locationIds.length === 0
				? eq(OrganizationLocation.id, '')
				: and(
						eq(OrganizationLocation.organizationId, organization.id),
						inArray(OrganizationLocation.id, locationIds),
					)
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(locationFilter)
		.orderBy(asc(OrganizationLocation.name))
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	return {
		orgSlug: params.orgSlug,
		tokenUrl: `/${params.orgSlug}/reports/token`,
		tenantApiUrl,
		salesBasis,
		locations,
		locationIds,
	}
}

export default function ScorecardPage() {
	const { tokenUrl, tenantApiUrl, salesBasis, locations } =
		useLoaderData<typeof loader>()
	const [rows, setRows] = useState<LocationScorecardEntry[] | null>(null)
	const [error, setError] = useState(false)

	const load = useCallback(async () => {
		setError(false)
		try {
			const tokenRes = await fetch(tokenUrl)
			const tokenBody = (await tokenRes.json()) as { token?: string }
			if (!tokenRes.ok || typeof tokenBody.token !== 'string') throw new Error()
			const res = await fetch(
				`${tenantApiUrl}/analytics/location-scorecard?preset=month_to_date&salesBasis=${salesBasis}`,
				{ headers: { Authorization: `Bearer ${tokenBody.token}` } },
			)
			if (!res.ok) throw new Error()
			const body = (await res.json()) as { rows?: LocationScorecardEntry[] }
			setRows(body.rows ?? buildLocationScorecard([]))
		} catch {
			setError(true)
			setRows(buildLocationScorecard([]))
		}
	}, [salesBasis, tenantApiUrl, tokenUrl])

	useEffect(() => {
		void load()
	}, [load])

	const names = useMemo(
		() => new Map(locations.map((row) => [row.id, row.name])),
		[locations],
	)
	const ranked = useMemo(
		() => rankLocations(rows ?? [], (a, b) => b.salesMinor - a.salesMinor),
		[rows],
	)

	return (
		<WorkspacePage>
			<h1 className="text-2xl font-semibold tracking-tight">
				<Trans>Location scorecard</Trans>
			</h1>
			{error ? (
				<p className="text-muted-foreground mb-4 text-sm">
					<Trans>Could not load scorecard from your region.</Trans>
				</p>
			) : null}
			{rows === null ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			) : ranked.length === 0 ? (
				<p data-testid="scorecard-empty">
					<Trans>Not enough data for this period yet.</Trans>
				</p>
			) : (
				<ol className="space-y-2 text-sm">
					{ranked.map((row, index) => (
						<li
							key={row.locationId}
							data-testid={`scorecard-${row.locationId}`}
						>
							<Trans>
								#{index + 1} {names.get(row.locationId) ?? row.locationId}{' '}
								{row.enoughData
									? `${(row.salesMinor / 100).toFixed(0)} sales`
									: 'not enough data'}
							</Trans>
						</li>
					))}
				</ol>
			)}
		</WorkspacePage>
	)
}
