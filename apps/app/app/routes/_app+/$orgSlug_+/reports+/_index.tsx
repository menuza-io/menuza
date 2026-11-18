import { Trans, t } from '@lingui/macro'
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
import { useLoaderData, useNavigate } from 'react-router'
import { ScopeWordingProvider } from '#app/components/staff/scope-wording-provider.tsx'
import { listLocationTags } from '#app/utils/location/tags.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
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
	const grants = await resolveReportGrantsForRequest(
		request,
		userId,
		organization.id,
	)
	const { catalog: fullCatalog, scopeWording } =
		await organizationReportCatalog(organization.id)
	const catalog = catalogForGrants(fullCatalog, grants)
	// A link can open the page on one category (Reservations) and keep the
	// location it came from; both only steer the page, they grant nothing.
	const url = new URL(request.url)
	const location = url.searchParams.get('location')
	const tags = await listLocationTags(organization.id)
	const requestedTag = url.searchParams.get('tag')
	return {
		category: url.searchParams.get('category'),
		location: location && location.length <= 64 ? location : null,
		// Location tags (#374): the picker limits new reports to a tag's locations.
		tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
		tag: tags.some((tag) => tag.id === requestedTag) ? requestedTag : null,
		scopeWording,
		orgSlug: organization.slug,
		organizationName: organization.name,
		savedReports: saved
			.filter((report) =>
				definitionAllowed(
					fullCatalog,
					parseDefinition(report.definition),
					grants,
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
			grants,
		),
	}
}

export default function ReportsIndex() {
	const data = useLoaderData<typeof loader>()
	const navigate = useNavigate()
	const basePath = `/${data.orgSlug}/reports`
	const templateQuery =
		[
			data.location ? `location=${encodeURIComponent(data.location)}` : null,
			data.tag ? `tag=${encodeURIComponent(data.tag)}` : null,
		]
			.filter(Boolean)
			.join('&') || undefined

	return (
		<ScopeWordingProvider wording={data.scopeWording}>
			{data.tags.length > 0 ? (
				<div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 pt-4">
					<label htmlFor="report-tag" className="text-sm font-medium">
						<Trans>Location tag</Trans>
					</label>
					<select
						id="report-tag"
						className="bg-card border-input h-8 rounded-md border px-2 text-sm"
						value={data.tag ?? ''}
						onChange={(event) => {
							const next = new URLSearchParams(window.location.search)
							if (event.target.value) next.set('tag', event.target.value)
							else next.delete('tag')
							void navigate(`?${next.toString()}`)
						}}
					>
						<option value="">{t`All locations`}</option>
						{data.tags.map((tag) => (
							<option key={tag.id} value={tag.id}>
								{tag.name}
							</option>
						))}
					</select>
					<span className="text-muted-foreground text-xs">
						<Trans>New reports show only the locations with this tag.</Trans>
					</span>
				</div>
			) : null}
			<ReportStart
				heading="Analytics & Reports"
				description={`Track sales, orders, customers, marketing, and reviews for ${data.organizationName}. Order and customer reports run in your data region, straight from the browser, and never pass through the US control plane.`}
				templates={data.templates}
				savedReports={data.savedReports}
				basePath={basePath}
				category={data.category}
				templateQuery={templateQuery}
			/>
		</ScopeWordingProvider>
	)
}
