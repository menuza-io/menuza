import { requireUserId } from '@repo/auth'
import { templatesFor } from '@repo/reports'
import { listSavedReports, parseDefinition } from '@repo/reports/server'
import { ReportStart } from '@repo/reports/ui'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	const saved = await listSavedReports({
		scope: 'organization',
		organizationId: organization.id,
	})
	return {
		orgSlug: organization.slug,
		organizationName: organization.name,
		savedReports: saved.map((report) => ({
			id: report.id,
			title: report.title,
			updatedAt: report.updatedAt.toISOString(),
			subject: parseDefinition(report.definition).subject,
		})),
		templates: templatesFor('organization'),
	}
}

export default function ReportsIndex() {
	const data = useLoaderData<typeof loader>()
	const basePath = `/${data.orgSlug}/reports`

	return (
		<ReportStart
			heading="Analytics & Reports"
			description={`Build a segmentation report for ${data.organizationName}. Customer and shop order counts run in the org data region from the browser and never pass through the US control plane.`}
			templates={data.templates}
			savedReports={data.savedReports}
			basePath={basePath}
		/>
	)
}
