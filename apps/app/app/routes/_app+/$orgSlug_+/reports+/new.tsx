import { requireUserId } from '@repo/auth'
import {
	blankReportDefinition,
	catalogForGrants,
	definitionAllowed,
	definitionForNewReport,
	getCatalog,
} from '@repo/reports'
import { parseDefinition, saveReport } from '@repo/reports/server'
import { redirect, useLoaderData } from 'react-router'
import { AppReportWorkspace } from '#app/components/reports/report-workspace.tsx'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/reservations/report-access.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/new.ts'

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
	)
	// A template the person has no access to opens a blank report instead.
	const definition = definitionAllowed(fullCatalog, requested, grants)
		? requested
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
