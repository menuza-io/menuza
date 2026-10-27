import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type JourneyRunRecord,
	type JourneyStepExecutionRecord,
} from '@repo/marketing-workflow'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useState } from 'react'
import {
	Link,
	useLoaderData,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
} from 'react-router'
import { type BreadcrumbHandle } from '#app/utils/breadcrumb.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export const handle: BreadcrumbHandle<Awaited<ReturnType<typeof loader>>> = {
	breadcrumb: (data) => data.journey.name,
}

type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived'
type RunStatus = 'completed' | 'running' | 'failed' | 'cancelled'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const journeyId = params.journeyId || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_AUTOMATION_ANY,
	)

	const [journeyRes, runsRes] = await Promise.all([
		fetchTenant(`/operator/journeys/${journeyId}`),
		fetchTenant(`/operator/journeys/${journeyId}/runs`),
	])

	if (!journeyRes.ok) {
		throw new Response(i18n._(t`Automation not found`), { status: 404 })
	}

	const journeyData = (await journeyRes.json()) as any
	const runsData = runsRes.ok ? ((await runsRes.json()) as any) : { runs: [] }

	const runs: JourneyRunRecord[] = (runsData.runs || []).map((r: any) => ({
		id: r.id,
		journeyId: r.journeyId,
		customerId: r.customerId,
		status: r.status,
		startedAt: r.startedAt || r.createdAt,
		completedAt: r.completedAt,
		currentStepNodeId: r.currentStepNodeId,
		errorMessage: r.errorMessage,
		createdAt: r.createdAt,
	}))

	return {
		orgSlug,
		journey: {
			id: journeyData.journey.id,
			name: journeyData.journey.name,
			status: journeyData.journey.status,
			triggerType: journeyData.journey.triggerType,
		},
		runs,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { orgId, fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_AUTOMATION_ANY,
	)

	const formData = await request.formData()
	const runId = formData.get('runId')

	if (typeof runId !== 'string' || !runId) {
		return { error: i18n._(t`runId is required`) }
	}

	const res = await fetchTenant(
		`/operator/journeys/runs/${encodeURIComponent(runId)}`,
	)
	if (!res.ok) {
		return { error: i18n._(t`Failed to load timeline`) }
	}

	const data = (await res.json()) as any
	return { timeline: data.timeline || data.steps || [] }
}

export default function JourneyRunsRoute() {
	const { _ } = useLingui()
	const { orgSlug, journey, runs } = useLoaderData<typeof loader>()
	const [selectedRun, setSelectedRun] = useState<JourneyRunRecord | null>(null)
	const [timeline, setTimeline] = useState<JourneyStepExecutionRecord[]>([])
	const [loadingTimeline, setLoadingTimeline] = useState(false)

	const journeyStatusLabels: Record<JourneyStatus, string> = {
		draft: _(msg`Draft`),
		active: _(msg`Active`),
		paused: _(msg`Paused`),
		archived: _(msg`Archived`),
	}

	const runStatusLabels: Record<RunStatus, string> = {
		completed: _(msg`Completed`),
		running: _(msg`Running`),
		failed: _(msg`Failed`),
		cancelled: _(msg`Cancelled`),
	}

	const formatDuration = (
		startedAt: string | Date,
		completedAt?: string | Date | null,
	) => {
		if (!startedAt) return '—'
		const start = new Date(startedAt).getTime()
		const end = completedAt ? new Date(completedAt).getTime() : Date.now()
		const diffSec = Math.max(0, Math.floor((end - start) / 1000))

		if (!completedAt) {
			return _(msg`${diffSec}s (running)`)
		}

		if (diffSec < 60) return _(msg`${diffSec}s`)
		const minutes = Math.floor(diffSec / 60)
		const remainingSec = diffSec % 60
		return _(msg`${minutes}m ${remainingSec}s`)
	}

	const openTimeline = async (run: JourneyRunRecord) => {
		setSelectedRun(run)
		setLoadingTimeline(true)
		try {
			const res = await fetch(
				`/${orgSlug}/marketing/automations/${journey.id}/runs`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ runId: run.id }),
				},
			)
			const data = (await res.json()) as any
			setTimeline(data.timeline || [])
		} catch {
			setTimeline([])
		} finally {
			setLoadingTimeline(false)
		}
	}

	const journeyStatus = journey.status as JourneyStatus
	const triggerLabel = journey.triggerType.replace('_', ' ')
	const runCount = runs.length
	const selectedRunId = selectedRun?.id ?? ''
	const timelineCount = timeline.length

	return (
		<div className="space-y-6">
			<PageHeader
				title={
					<span className="flex flex-wrap items-center gap-2">
						{journey.name}
						<Badge
							variant={
								journey.status === 'active'
									? 'success'
									: journey.status === 'paused'
										? 'warning'
										: 'secondary'
							}
						>
							{journeyStatusLabels[journeyStatus]}
						</Badge>
					</span>
				}
				description={_(
					msg`Execution runs and step history, triggered by "${triggerLabel}".`,
				)}
				actions={
					<Button
						render={
							<Link to={`/${orgSlug}/marketing/automations/${journey.id}`} />
						}
						variant="outline"
						size="sm"
					>
						<Icon name="pencil" />
						{_(msg`Open visual builder`)}
					</Button>
				}
			/>

			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-base">
						{_(msg`Execution History (${runCount})`)}
					</CardTitle>
					<CardDescription>
						{_(
							msg`All customer automation workflows orchestrated durably by Cloudflare Workflows and executed by the regional data engine.`,
						)}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{runs.length === 0 ? (
						<div className="text-muted-foreground space-y-3 py-12 text-center text-sm">
							<p>
								{_(msg`No execution runs recorded yet for this automation.`)}
							</p>
							<Button
								render={
									<Link
										to={`/${orgSlug}/marketing/automations/${journey.id}`}
									/>
								}
								size="sm"
								variant="outline"
							>
								{_(msg`Launch Test Run in Builder`)}
							</Button>
						</div>
					) : (
						<div className="overflow-x-auto rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow className="bg-muted/50">
										<TableHead className="w-[180px]">
											{_(msg`Run ID`)}
										</TableHead>
										<TableHead>{_(msg`Customer UUID`)}</TableHead>
										<TableHead>{_(msg`Status`)}</TableHead>
										<TableHead>{_(msg`Started At`)}</TableHead>
										<TableHead>{_(msg`Duration`)}</TableHead>
										<TableHead className="text-right">
											{_(msg`Audit Trail`)}
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{runs.map((run) => (
										<TableRow key={run.id} className="hover:bg-muted/30">
											<TableCell className="font-mono text-xs">
												{run.id.slice(0, 8)}...{run.id.slice(-6)}
											</TableCell>
											<TableCell className="text-muted-foreground font-mono text-xs">
												{run.customerId}
											</TableCell>
											<TableCell>
												<Badge
													variant="outline"
													className={cn(
														'text-[10px] capitalize',
														run.status === 'completed' &&
															'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
														run.status === 'running' &&
															'animate-pulse border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
														run.status === 'failed' &&
															'bg-destructive/10 text-destructive border-destructive/30',
														run.status === 'cancelled' &&
															'bg-muted text-muted-foreground',
													)}
												>
													{runStatusLabels[run.status as RunStatus] ??
														run.status}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground text-xs">
												{new Date(run.startedAt).toLocaleString()}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{formatDuration(run.startedAt, run.completedAt)}
											</TableCell>
											<TableCell className="text-right">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													className="text-primary hover:text-primary hover:bg-primary/10 h-9 text-xs font-medium"
													onClick={() => openTimeline(run)}
												>
													{_(msg`View Timeline →`)}
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={Boolean(selectedRun)}
				onOpenChange={(open) => {
					if (!open) setSelectedRun(null)
				}}
			>
				<DialogContent className="sm:max-w-[560px]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<span>{_(msg`Run Execution Timeline`)}</span>
							{selectedRun && (
								<Badge
									variant="outline"
									className={cn(
										'text-[10px] capitalize',
										selectedRun.status === 'completed' &&
											'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
										selectedRun.status === 'running' &&
											'border-blue-500/30 bg-blue-500/10 text-blue-600',
										selectedRun.status === 'failed' &&
											'bg-destructive/10 text-destructive border-destructive/30',
									)}
								>
									{runStatusLabels[selectedRun.status as RunStatus] ??
										selectedRun.status}
								</Badge>
							)}
						</DialogTitle>
						<DialogDescription className="font-mono text-xs">
							{_(msg`Run ID: ${selectedRunId}`)}
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-2">
						{selectedRun?.errorMessage && (
							<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-3 text-xs">
								<p className="font-semibold">{_(msg`Workflow Error:`)}</p>
								<p>{selectedRun.errorMessage}</p>
							</div>
						)}

						{loadingTimeline ? (
							<p className="text-muted-foreground py-6 text-center text-sm">
								{_(msg`Loading step executions from regional SQLite outbox...`)}
							</p>
						) : timeline.length === 0 ? (
							<div className="text-muted-foreground py-6 text-center text-sm">
								{_(
									msg`No discrete action step dispatches recorded for this run.`,
								)}
							</div>
						) : (
							<div className="space-y-3">
								<h4 className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
									{_(msg`Step Executions (${timelineCount})`)}
								</h4>
								<div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
									{timeline.map((step, idx) => {
										const attempt = step.attempt
										const executedAtLabel = step.executedAt
											? new Date(step.executedAt).toLocaleTimeString()
											: _(msg`Pending`)

										return (
											<div
												key={step.id || idx}
												className="bg-card flex items-start justify-between rounded-lg border p-3 shadow-2xs"
											>
												<div className="space-y-1">
													<div className="flex items-center gap-2">
														<span className="text-foreground font-mono text-xs">
															{step.nodeId}
														</span>
														<Badge
															variant="outline"
															className="text-[9px] tracking-wider uppercase"
														>
															{step.nodeType}
														</Badge>
													</div>
													<p className="text-muted-foreground font-mono text-[11px]">
														{_(
															msg`Attempt: ${attempt} • Executed: ${executedAtLabel}`,
														)}
													</p>
													{step.errorMessage && (
														<p className="text-destructive text-xs">
															{step.errorMessage}
														</p>
													)}
												</div>

												<Badge
													variant="outline"
													className={cn(
														'shrink-0 text-[10px] capitalize',
														step.status === 'completed' ||
															step.status === 'delivered'
															? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
															: step.status === 'failed'
																? 'bg-destructive/10 text-destructive border-destructive/30'
																: 'bg-muted text-muted-foreground',
													)}
												>
													{step.status}
												</Badge>
											</div>
										)
									})}
								</div>
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	)
}
