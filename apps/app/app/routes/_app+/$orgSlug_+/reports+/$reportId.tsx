import { requireUserId } from '@repo/auth'
import { getCatalog, getSubject } from '@repo/reports'
import {
	getSavedReport,
	parseDefinition,
	saveReport,
} from '@repo/reports/server'
import { useLoaderData } from 'react-router'
import { AppReportWorkspace } from '#app/components/reports/report-workspace.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/$reportId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
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
	return {
		catalog: getCatalog('organization'),
		definition: parseDefinition(report.definition),
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
