import { requireUserId } from '@repo/auth'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import {
	blankReportDefinition,
	catalogForGrants,
	definitionAllowed,
	definitionForNewReport,
	getCatalog,
	withDriverDeliveries,
	withLocationFilter,
	withLocationsFilter,
} from '@repo/reports'
import { parseDefinition, saveReport } from '@repo/reports/server'
import { redirect, useLoaderData } from 'react-router'
import { AppReportWorkspace } from '#app/components/reports/report-workspace.tsx'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import { locationNamesForTag } from '#app/utils/location/tags.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/new.ts'

/** The name of one of the organization's locations, or null when it is not one. */
async function findLocationName(
	organizationId: string,
	locationId: string | null,
) {
	if (!locationId) return null
	const [row] = await db
		.select({ name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	return row?.name ?? null
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})
	const url = new URL(request.url)
	const grants = await resolveReportGrantsForRequest(
		request,
		userId,
		organization.id,
	)
	const { catalog: fullCatalog, scopeWording } =
		await organizationReportCatalog(organization.id)
	const catalog = catalogForGrants(fullCatalog, grants)
	const requested = definitionForNewReport(
		'organization',
		url.searchParams.get('template'),
		url.searchParams.get('category'),
	)
	// A template the person has no access to opens a blank report instead.
	const allowed = definitionAllowed(fullCatalog, requested, grants)
	// A link from Reservations keeps the location the person was working in.
	const locationName = await findLocationName(
		organization.id,
		url.searchParams.get('location'),
	)
	// A link or the tag picker on Reports can limit the report to a location tag
	// (#374). Only the person's own locations are named; an unknown tag changes
	// nothing.
	const tagId = url.searchParams.get('tag')
	const tagLocationNames =
		tagId && tagId.length <= 64
			? await locationNamesForTag(
					organization.id,
					tagId,
					await resolveMemberLocationIds(userId, organization.id),
				)
			: null
	// "Open deliveries" on a Deliveries by driver row (#324): that driver, that period.
	const withDriver = withDriverDeliveries(requested, {
		driverKey: url.searchParams.get('driver'),
		preset: url.searchParams.get('preset'),
		start: url.searchParams.get('start'),
		end: url.searchParams.get('end'),
	})
	const definition = allowed
		? withLocationsFilter(
				'organization',
				withLocationFilter('organization', withDriver, locationName),
				tagLocationNames,
			)
		: blankReportDefinition('organization')

	return {
		scopeWording,
		catalog,
		definition,
		orgSlug: organization.slug,
		hasProvisionedDb: organization.hasProvisionedDb,
		tenantApiUrl: resolveRegionalTenantApiUrls(organization.dataRegion)
			.tenantApiUrl,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const form = await request.formData()
	const definition = parseDefinition(form.get('definition'))
	const grants = await resolveReportGrantsForRequest(
		request,
		userId,
		organization.id,
	)
	if (!definitionAllowed(getCatalog('organization'), definition, grants)) {
		throw new Response('Forbidden', { status: 403 })
	}
	const saved = await saveReport({
		scope: 'organization',
		organizationId: organization.id,
		createdById: userId,
		definition,
	})
	if (!saved) {
		return { ok: false as const, error: 'Could not save report' }
	}
	throw redirect(`/${organization.slug}/reports/${saved.id}`)
}

export default function NewReportRoute() {
	const data = useLoaderData<typeof loader>()

	return (
		<ScopeWordingProvider wording={data.scopeWording}>
			<AppReportWorkspace
				catalog={data.catalog}
				scope="organization"
				initialDefinition={data.definition}
				controlPlaneRunUrl={`/${data.orgSlug}/reports/run`}
				// The builder can switch to a regional subject at any time.
				tenantTokenUrl={`/${data.orgSlug}/reports/token`}
				tenantApiUrl={data.tenantApiUrl}
				backHref={`/${data.orgSlug}/reports`}
				hasTenantDb={data.hasProvisionedDb}
			/>
		</ScopeWordingProvider>
	)
}
