import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
	useFetcher,
	useLocation,
	useNavigate,
	useSearchParams,
} from 'react-router'
import { type ReportCatalog, type ReportScope } from '../catalog.ts'
import { type ReportDefinition, reportDefinitionSchema } from '../dsl.ts'
import { ReportBuilder } from './report-builder.tsx'
import { useReportRunner } from './use-report-runner.ts'

function cloneDefinition(definition: ReportDefinition): ReportDefinition {
	return reportDefinitionSchema.parse(definition)
}

export function ReportWorkspace({
	catalog,
	scope,
	initialDefinition,
	controlPlaneRunUrl,
	tenantTokenUrl,
	tenantApiUrl,
	backHref,
	hasTenantDb,
	headerExtras,
	contentClassName,
}: {
	catalog: ReportCatalog
	scope: ReportScope
	initialDefinition: ReportDefinition
	controlPlaneRunUrl: string
	tenantTokenUrl?: string | null
	tenantApiUrl?: string | null
	backHref: string
	hasTenantDb?: boolean
	headerExtras?: ReactNode
	contentClassName?: string
}) {
	const [definition, setDefinition] = useState(() =>
		cloneDefinition(initialDefinition),
	)
	const [searchParams] = useSearchParams()
	const location = useLocation()
	const fetcher = useFetcher<{ ok?: boolean; id?: string; error?: string }>()
	const navigate = useNavigate()
	const { result, error, loading, updatedAt } = useReportRunner({
		catalog,
		definition,
		controlPlaneRunUrl,
		tenantTokenUrl,
		tenantApiUrl,
	})
	const templateId = searchParams.get('template')
	const isNewReport = location.pathname.endsWith('/new')

	// Another template picked while the builder is open starts from that
	// template. The first render already holds `initialDefinition`, which can
	// carry more than the bare template (a location filter from the link), so
	// it must not be replaced by the bare template.
	const firstTemplateRender = useRef(true)
	const initialDefinitionRef = useRef(initialDefinition)
	initialDefinitionRef.current = initialDefinition
	useEffect(() => {
		if (firstTemplateRender.current) {
			firstTemplateRender.current = false
			return
		}
		if (!isNewReport) return
		setDefinition(cloneDefinition(initialDefinitionRef.current))
	}, [isNewReport, scope, templateId])

	useEffect(() => {
		if (fetcher.data?.ok && fetcher.data.id && fetcher.state === 'idle') {
			const nextHref = `${backHref}/${fetcher.data.id}`
			if (!window.location.pathname.endsWith(`/${fetcher.data.id}`)) {
				navigate(nextHref, { replace: true })
			}
		}
	}, [backHref, fetcher.data, fetcher.state, navigate])

	return (
		<div className="bg-muted fixed inset-0 z-50 flex h-dvh min-h-0 flex-col overflow-hidden">
			<ReportBuilder
				catalog={catalog}
				definition={definition}
				onChange={setDefinition}
				result={result}
				error={error}
				loading={loading}
				updatedAt={updatedAt}
				saving={fetcher.state !== 'idle'}
				saveError={fetcher.data?.error}
				backHref={backHref}
				hasTenantDb={hasTenantDb}
				headerExtras={headerExtras}
				contentClassName={contentClassName}
				onSave={() => {
					fetcher.submit(
						{
							intent: 'save',
							definition: JSON.stringify(definition),
						},
						{ method: 'post' },
					)
				}}
			/>
		</div>
	)
}
