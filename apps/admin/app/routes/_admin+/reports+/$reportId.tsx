import { requireUserWithRole } from '@repo/auth'
import { getCatalog } from '@repo/reports'
import {
	getSavedReport,
	parseDefinition,
	saveReport,
} from '@repo/reports/server'
import { ReportWorkspace } from '@repo/reports/ui'
import { useLoaderData } from 'react-router'
import { type Route } from './+types/$reportId.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')
	const report = await getSavedReport({
		id: params.reportId ?? '',
		scope: 'platform',
	})
	if (!report) {
		throw new Response('Not Found', { status: 404 })
	}
	return {
		catalog: getCatalog('platform'),
		definition: parseDefinition(report.definition),
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserWithRole(request, 'admin')
	const form = await request.formData()
	const definition = parseDefinition(form.get('definition'))
	const saved = await saveReport({
		id: params.reportId,
		scope: 'platform',
		organizationId: null,
		createdById: userId,
		definition,
	})
	if (!saved) {
		return { ok: false as const, error: 'Could not save report' }
	}
	return { ok: true as const, id: saved.id }
}

export default function AdminSavedReportRoute() {
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
