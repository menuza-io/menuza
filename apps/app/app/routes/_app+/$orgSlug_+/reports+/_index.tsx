import { requireUserId } from '@repo/auth'
import {
	catalogForGrants,
	definitionAllowed,
	getSubject,
	templatesFor,
	templatesForGrants,
} from '@repo/reports'
import { listSavedReports, parseDefinition } from '@repo/reports/server'
import { ReportStart } from '@repo/reports/ui'
import { useLoaderData } from 'react-router'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveStaffReportAccessForRequest } from '#app/utils/staffing/report-access.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { type Route } from './+types/_index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})

	const saved = await listSavedReports({
		scope: 'organization',
		organizationId: organization.id,
	})
	// Staff reports show only to people whose flags and permissions grant them.
	const staff = await resolveStaffReportAccessForRequest(
		request,
		userId,
		organization.id,
	)
	const { catalog: fullCatalog, scopeWording } =
		await organizationReportCatalog(organization.id)
	const catalog = catalogForGrants(fullCatalog, staff.subjects)
	return {
		scopeWording,
		orgSlug: organization.slug,
		organizationName: organization.name,
		savedReports: saved
			.filter((report) =>
				definitionAllowed(
					fullCatalog,
					parseDefinition(report.definition),
					staff.subjects,
				),
			)
			.map((report) => {
				const subject = parseDefinition(report.definition).subject
				return {
					id: report.id,
					title: report.title,
					updatedAt: report.updatedAt.toISOString(),
					subject: getSubject(catalog, subject)?.label ?? subject,
				}
			}),
		templates: templatesForGrants(
			fullCatalog,
			templatesFor('organization'),
			staff.subjects,
		),
	}
}

export default function ReportsIndex() {
	const data = useLoaderData<typeof loader>()
	const basePath = `/${data.orgSlug}/reports`

	return (
		<ScopeWordingProvider wording={data.scopeWording}>
			<ReportStart
				heading="Analytics & Reports"
				description={`Track sales, orders, customers, marketing, and reviews for ${data.organizationName}. Order and customer reports run in your data region, straight from the browser, and never pass through the US control plane.`}
				templates={data.templates}
				savedReports={data.savedReports}
				basePath={basePath}
			/>
		</ScopeWordingProvider>
	)
}
