import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { auditService } from '@repo/audit'
import { requireUserWithRole } from '@repo/auth'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardHeader, CardContent, CardTitle } from '@repo/ui/card'
import { type FilterField } from '@repo/ui/filters'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useMemo, useState } from 'react'
import { useLoaderData } from 'react-router'
import { TablePagination } from '#app/components/data-table/table-pagination.tsx'
import { UrlFilters } from '#app/components/data-table/url-filters.tsx'
import { EmptyState } from '#app/components/empty-state.tsx'

export async function loader({ request }: { request: Request }) {
	await requireUserWithRole(request, 'admin')

	const url = new URL(request.url)
	const page = Number(url.searchParams.get('page')) || 1
	const limit = 50
	const offset = (page - 1) * limit

	// Get filter parameters
	const organizationId = url.searchParams.get('organizationId') || undefined
	const userId = url.searchParams.get('userId') || undefined
	const search = url.searchParams.get('search') || undefined
	const startDateStr = url.searchParams.get('startDate')
	const endDateStr = url.searchParams.get('endDate')
	const severityFilter = url.searchParams.get('severity') || undefined

	const startDate = startDateStr ? new Date(startDateStr) : undefined
	const endDate = endDateStr ? new Date(endDateStr) : undefined

	// Query audit logs and statistics in parallel
	const [result, statistics] = await Promise.all([
		auditService.query({
			organizationId,
			userId,
			search,
			startDate,
			endDate,
			limit,
			offset,
		}),
		auditService.getStatistics(organizationId),
	])

	// Metadata is already parsed by the auditService, but we ensure it's a valid object
	const logsWithParsedMetadata = result.logs.map((log) => ({
		...log,
		parsedMetadata: log.metadata
			? ((typeof log.metadata === 'string'
					? JSON.parse(log.metadata)
					: log.metadata) as Record<string, unknown>)
			: {},
	}))

	const totalPages = Math.ceil(result.totalCount / limit)

	return {
		...result,
		total: result.totalCount,
		page,
		totalPages,
		logs: logsWithParsedMetadata,
		statistics,
		filters: {
			organizationId,
			userId,
			search,
			startDate: startDateStr,
			endDate: endDateStr,
			severity: severityFilter,
		},
	}
}

export default function EnhancedAuditLogsPage() {
	const { _ } = useLingui()
	const { logs, total, page, totalPages, statistics, filters } =
		useLoaderData<typeof loader>()
	const [isExporting, setIsExporting] = useState(false)

	const handleExport = async (format: 'csv' | 'json') => {
		setIsExporting(true)
		try {
			const params = new URLSearchParams()
			params.set('format', format)
			if (filters.organizationId)
				params.set('organizationId', filters.organizationId)
			if (filters.userId) params.set('userId', filters.userId)
			if (filters.startDate) params.set('startDate', filters.startDate)
			if (filters.endDate) params.set('endDate', filters.endDate)

			const url = `/audit-logs/export?${params.toString()}`
			window.open(url, '_blank')
		} finally {
			setIsExporting(false)
		}
	}

	const filterFields = useMemo<FilterField[]>(
		() => [
			{
				id: 'search',
				label: _(msg`Search`),
				type: 'text',
				defaultOperator: 'contains',
				operators: [{ value: 'contains', label: _(msg`contains`) }],
				placeholder: _(msg`Details or action`),
				icon: <Icon name="search" className="size-3.5" />,
			},
			{
				id: 'startDate',
				label: _(msg`Start date`),
				type: 'text',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`from`) }],
				placeholder: 'YYYY-MM-DD',
				icon: <Icon name="calendar" className="size-3.5" />,
			},
			{
				id: 'endDate',
				label: _(msg`End date`),
				type: 'text',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`until`) }],
				placeholder: 'YYYY-MM-DD',
				icon: <Icon name="calendar" className="size-3.5" />,
			},
			{
				id: 'severity',
				label: _(msg`Severity`),
				type: 'select',
				defaultOperator: 'is',
				operators: [{ value: 'is', label: _(msg`is`) }],
				searchable: false,
				icon: <Icon name="alert-triangle" className="size-3.5" />,
				options: [
					{ value: 'info', label: _(msg`Info`) },
					{ value: 'warning', label: _(msg`Warning`) },
					{ value: 'error', label: _(msg`Error`) },
					{ value: 'critical', label: _(msg`Critical`) },
				],
			},
		],
		[_],
	)

	const getSeverityBadgeVariant = (severity: string) => {
		switch (severity) {
			case 'critical':
				return 'destructive'
			case 'error':
				return 'destructive'
			case 'warning':
				return 'default'
			default:
				return 'secondary'
		}
	}

	const count = statistics.topActions[0]?._count || 0
	const showing = logs.length
	const totalEvents = total.toLocaleString()

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Audit Logs</Trans>}
				description={
					<Trans>
						Comprehensive activity tracking and compliance audit trail
					</Trans>
				}
				actions={
					<>
						<Button
							variant="outline"
							onClick={() => handleExport('csv')}
							disabled={isExporting}
						>
							<Icon name="download" className="size-4" />
							<Trans>Export CSV</Trans>
						</Button>
						<Button
							variant="outline"
							onClick={() => handleExport('json')}
							disabled={isExporting}
						>
							<Icon name="download" className="size-4" />
							<Trans>Export JSON</Trans>
						</Button>
					</>
				}
			/>

			{/* Statistics Cards */}
			<div className="grid gap-4 md:grid-cols-3">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Total Events</Trans>
						</CardTitle>
						<Icon name="activity" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{statistics.totalEvents.toLocaleString()}
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Security Events</Trans>
						</CardTitle>
						<Icon name="shield" className="text-muted-foreground h-4 w-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{statistics.recentSecurityEvents.length}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>In last 100 events</Trans>
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							<Trans>Top Action</Trans>
						</CardTitle>
						<Icon
							name="trending-up"
							className="text-muted-foreground h-4 w-4"
						/>
					</CardHeader>
					<CardContent>
						<div className="text-sm font-medium">
							{statistics.topActions[0]?.action || <Trans>N/A</Trans>}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>{count} occurrences</Trans>
						</p>
					</CardContent>
				</Card>
			</div>

			<div className="space-y-4">
				<UrlFilters fields={filterFields} />

				{logs.length > 0 ? (
					<Frame className="w-full">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Severity</Trans>
									</TableHead>
									<TableHead>
										<Trans>Event</Trans>
									</TableHead>
									<TableHead className="hidden md:table-cell">
										<Trans>User</Trans>
									</TableHead>
									<TableHead className="hidden lg:table-cell">
										<Trans>Resource</Trans>
									</TableHead>
									<TableHead>
										<Trans>Time</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{logs.map((log) => {
									const metadata = log.parsedMetadata
									return (
										<TableRow key={log.id}>
											<TableCell>
												<Badge
													variant={getSeverityBadgeVariant(
														String(metadata.severity || 'info'),
													)}
												>
													{String(metadata.severity || 'info')}
												</Badge>
											</TableCell>
											<TableCell className="max-w-md whitespace-normal">
												<div className="text-muted-foreground font-mono text-xs">
													{log.action}
												</div>
												<div className="text-sm">{log.details}</div>
											</TableCell>
											<TableCell className="text-muted-foreground hidden text-sm md:table-cell">
												{log.user ? log.user.name || log.user.username : '—'}
												{metadata.ipAddress ? (
													<div className="font-mono text-xs">
														{metadata.ipAddress as string}
													</div>
												) : null}
											</TableCell>
											<TableCell className="text-muted-foreground hidden font-mono text-xs lg:table-cell">
												{log.resourceType
													? `${log.resourceType}: ${log.resourceId?.substring(0, 8) ?? ''}`
													: '—'}
											</TableCell>
											<TableCell className="text-muted-foreground text-sm whitespace-nowrap">
												{new Date(log.createdAt).toLocaleString()}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
							<TableFooter>
								<TableRow>
									<TableCell colSpan={5}>
										<Trans>
											Showing {showing} of {totalEvents} events
										</Trans>
									</TableCell>
								</TableRow>
							</TableFooter>
						</Table>
					</Frame>
				) : (
					<EmptyState
						title={_(msg`No audit logs found`)}
						description={_(msg`Try different filters or clear them.`)}
						icons={['file-text']}
					/>
				)}

				<TablePagination
					showPageSize={false}
					pagination={{
						page,
						pageSize: 50,
						totalCount: total,
						totalPages,
					}}
				/>
			</div>
		</div>
	)
}
