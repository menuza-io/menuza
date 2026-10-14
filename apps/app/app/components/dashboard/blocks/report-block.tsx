import { Trans } from '@lingui/macro'
import { buttonVariants } from '@repo/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Component,
	lazy,
	Suspense,
	type ErrorInfo,
	type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { type ReportBlockConfig } from '#app/utils/dashboards/config.ts'
import {
	resolveReportBlock,
	type ReportBlockData,
	type SavedReportOption,
} from '#app/utils/dashboards/reports.ts'
import { ReportBlockMessage } from './report-block-message.tsx'

// Charts load with the first report block instead of with the dashboard.
const ReportBlockResult = lazy(() =>
	import('./report-block-result.tsx').then((module) => ({
		default: module.ReportBlockResult,
	})),
)

function ResultLoading() {
	return <Skeleton aria-hidden="true" className="min-h-0 flex-1 rounded-lg" />
}

/** Keeps a report that fails to render from taking the dashboard down. */
class ReportBlockErrorBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	constructor(props: { children: ReactNode }) {
		super(props)
		this.state = { failed: false }
	}

	static getDerivedStateFromError() {
		return { failed: true }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('Report block failed to render:', error, info)
	}

	render() {
		if (this.state.failed) {
			return (
				<ReportBlockMessage
					icon="alert-triangle"
					title={<Trans>Cannot show this report</Trans>}
				>
					<Trans>Reload the page to try again.</Trans>
				</ReportBlockMessage>
			)
		}
		return this.props.children
	}
}

/**
 * A saved report or report template in a dashboard block: its title,
 * subject and a link to the full report above a compact result.
 */
export function ReportBlock({
	config,
	orgSlug,
	reports,
	savedReportOptions,
	editable = true,
}: {
	config: ReportBlockConfig
	orgSlug: string
	/** Null until the page data includes report blocks. */
	reports: ReportBlockData | null
	/** Titles for saved reports added since the page data loaded. */
	savedReportOptions?: readonly SavedReportOption[]
	/** Whether the viewer can change the dashboard's blocks. */
	editable?: boolean
}) {
	const block = resolveReportBlock(config, {
		orgSlug,
		reports,
		savedReportOptions,
	})

	if (block.status === 'not-found') {
		return (
			<Card size="sm" className="h-full">
				<ReportBlockMessage
					icon="file-text"
					title={<Trans>Report not found</Trans>}
				>
					{editable ? (
						<Trans>
							This report was deleted. Remove the block or add another report.
						</Trans>
					) : (
						<Trans>This report was deleted.</Trans>
					)}
				</ReportBlockMessage>
			</Card>
		)
	}

	return (
		<Card size="sm" className="h-full">
			<CardHeader>
				{block.title ? (
					<CardTitle className="min-w-0 truncate" title={block.title}>
						{block.title}
					</CardTitle>
				) : (
					<Skeleton aria-hidden="true" className="h-5 w-32 rounded-md" />
				)}
				{block.subjectLabel ? (
					<CardDescription className="min-w-0 truncate text-xs">
						{block.subjectLabel}
					</CardDescription>
				) : null}
				{block.href ? (
					<CardAction>
						<Link
							to={block.href}
							className={buttonVariants({ variant: 'ghost', size: 'xs' })}
						>
							<Trans>Open report</Trans>
							<Icon name="arrow-right" className="rtl:-scale-x-100" />
						</Link>
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent className="flex min-h-0 flex-1 flex-col">
				{block.status === 'ready' && reports ? (
					<ReportBlockErrorBoundary>
						<Suspense fallback={<ResultLoading />}>
							<ReportBlockResult
								definition={block.definition}
								reports={reports}
							/>
						</Suspense>
					</ReportBlockErrorBoundary>
				) : block.status === 'unreadable' ? (
					<ReportBlockMessage
						icon="alert-triangle"
						title={<Trans>Cannot show this report</Trans>}
					>
						<Trans>Its saved settings could not be read.</Trans>
					</ReportBlockMessage>
				) : (
					<ResultLoading />
				)}
			</CardContent>
		</Card>
	)
}
