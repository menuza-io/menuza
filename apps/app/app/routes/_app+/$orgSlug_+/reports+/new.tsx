import { requireUserId } from '@repo/auth'
import { definitionForNewReport, getCatalog, getSubject } from '@repo/reports'
import { parseDefinition, saveReport } from '@repo/reports/server'
import { redirect, useLoaderData } from 'react-router'
import { AppReportWorkspace } from '#app/components/reports/report-workspace.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/new.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})
	const url = new URL(request.url)
	const catalog = getCatalog('organization')
	const definition = definitionForNewReport(
		'organization',
		url.searchParams.get('template'),
	)

	return {
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
	const subject = getSubject(data.catalog, data.definition.subject)

	return (
		<AppReportWorkspace
			catalog={data.catalog}
			scope="organization"
			initialDefinition={data.definition}
			controlPlaneRunUrl={`/${data.orgSlug}/reports/run`}
			tenantTokenUrl={
				subject?.source === 'tenant-api'
					? `/${data.orgSlug}/reports/token`
					: null
			}
			tenantApiUrl={data.tenantApiUrl}
			backHref={`/${data.orgSlug}/reports`}
			hasTenantDb={data.hasProvisionedDb}
		/>
	)
}
