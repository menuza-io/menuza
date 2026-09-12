import { requireUserWithRole } from '@repo/auth'
import { definitionForNewReport, getCatalog } from '@repo/reports'
import { parseDefinition, saveReport } from '@repo/reports/server'
import { ReportWorkspace } from '@repo/reports/ui'
import { redirect, useLoaderData } from 'react-router'
import { type Route } from './+types/new.ts'

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')
	const url = new URL(request.url)
	const definition = definitionForNewReport(
		'platform',
		url.searchParams.get('template'),
	)

	return {
		catalog: getCatalog('platform'),
		definition,
	}
}

export async function action({ request }: Route.ActionArgs) {
	const userId = await requireUserWithRole(request, 'admin')
	const form = await request.formData()
	const definition = parseDefinition(form.get('definition'))
	const saved = await saveReport({
		scope: 'platform',
		organizationId: null,
		createdById: userId,
		definition,
	})
	if (!saved) {
		return { ok: false as const, error: 'Could not save report' }
	}
	throw redirect(`/reports/${saved.id}`)
}

export default function AdminNewReportRoute() {
	const data = useLoaderData<typeof loader>()
	return (
		<div className="h-full min-h-0">
			<ReportWorkspace
				catalog={data.catalog}
				scope="platform"
				initialDefinition={data.definition}
				controlPlaneRunUrl="/reports/run"
				backHref="/reports"
			/>
		</div>
	)
}
