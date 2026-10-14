import { requireUserId } from '@repo/auth'
import { catalogForGrants, definitionAllowed, getCatalog } from '@repo/reports'
import {
	getSavedReport,
	parseDefinition,
	saveReport,
} from '@repo/reports/server'
import { useLoaderData } from 'react-router'
import { AppReportWorkspace } from '#app/components/reports/report-workspace.tsx'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveStaffReportAccessForRequest } from '#app/utils/staffing/report-access.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/$reportId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})
	const report = await getSavedReport({
		id: params.reportId ?? '',
		scope: 'organization',
		organizationId: organization.id,
	})
	if (!report) {
		throw new Response('Not Found', { status: 404 })
	}
	// A report on staff data looks like it does not exist to someone without
	// the flag or permission.
	const staff = await resolveStaffReportAccessForRequest(
		request,
		userId,
		organization.id,
	)
	const { catalog: fullCatalog, scopeWording } =
		await organizationReportCatalog(organization.id)
	const definition = parseDefinition(report.definition)
	if (!definitionAllowed(fullCatalog, definition, staff.subjects)) {
		throw new Response('Not Found', { status: 404 })
	}
	return {
		scopeWording,
		catalog: catalogForGrants(fullCatalog, staff.subjects),
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
	})
	const form = await request.formData()
	const definition = parseDefinition(form.get('definition'))
	const staff = await resolveStaffReportAccessForRequest(
		request,
		userId,
		organization.id,
	)
	if (
		!definitionAllowed(getCatalog('organization'), definition, staff.subjects)
	) {
		throw new Response('Forbidden', { status: 403 })
	}
	const saved = await saveReport({
		id: params.reportId,
		scope: 'organization',
		organizationId: organization.id,
		createdById: userId,
		definition,
	})
	if (!saved) {
		return { ok: false as const, error: 'Could not save report' }
	}
	return { ok: true as const, id: saved.id }
}

export default function SavedReportRoute() {
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
