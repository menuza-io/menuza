import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import {
	Link,
	redirect,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

const STATUS_FILTERS = ['all', 'active', 'draft', 'paused'] as const

export interface JourneyListItem {
	id: string
	name: string
	description?: string | null
	status: 'draft' | 'active' | 'paused' | 'archived'
	triggerType: string
	stepCount: number
	runsCount: number
	updatedAt: string
	createdAt: string
}

function JourneyStatusBadge({ status }: { status: JourneyListItem['status'] }) {
	const { _ } = useLingui()

	const statusLabels: Record<JourneyListItem['status'], string> = {
		draft: _(msg`Draft`),
		active: _(msg`Active`),
		paused: _(msg`Paused`),
		archived: _(msg`Archived`),
	}

	return (
		<Badge
			variant="outline"
			className={cn(
				'shrink-0 text-[10px] font-semibold capitalize',
				status === 'active' &&
					'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
				status === 'draft' && 'bg-muted text-muted-foreground border-border',
				status === 'paused' &&
					'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
				status === 'archived' &&
					'bg-destructive/10 text-destructive border-destructive/30',
			)}
		>
			{statusLabels[status]}
		</Badge>
	)
}

function formatTriggerType(triggerType: string) {
	return triggerType.replaceAll('_', ' ')
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { fetchTenant } = await getOperatorTenantClient(request, orgSlug)

	try {
		const res = await fetchTenant('/operator/journeys')
		if (!res.ok) {
			return {
				journeys: [] as JourneyListItem[],
				orgSlug,
				error: i18n._(t`Failed to load journeys from regional tenant storage.`),
			}
		}

		const data = (await res.json()) as {
			journeys?: Array<Record<string, unknown>>
		}
		const journeys: JourneyListItem[] = (data.journeys ?? []).map((j) => ({
			id: String(j.id),
			name: String(j.name),
			description: j.description as string | null | undefined,
			status: j.status as JourneyListItem['status'],
			triggerType: String(j.triggerType || 'phone_verified'),
			stepCount: Array.isArray(j.nodes) ? j.nodes.length : 0,
			runsCount: Number(j.runsCount) || 0,
			updatedAt: String(j.updatedAt || j.createdAt || new Date().toISOString()),
			createdAt: String(j.createdAt || new Date().toISOString()),
		}))

		return {
			journeys,
			orgSlug,
			error: null,
		}
	} catch (err) {
		return {
			journeys: [] as JourneyListItem[],
			orgSlug,
			error:
				err instanceof Error
					? err.message
					: i18n._(t`Database connection error`),
		}
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { fetchTenant } = await getOperatorTenantClient(request, orgSlug)
	const formData = await request.formData()
	const intent = formData.get('intent')
	const journeyId = formData.get('journeyId')

	if (typeof journeyId !== 'string' || !journeyId) {
		return { error: i18n._(t`journeyId is required`) }
	}

	if (intent === 'publish') {
		const res = await fetchTenant(`/operator/journeys/${journeyId}/publish`, {
			method: 'POST',
		})
		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			return {
				error:
					(err as { error?: string }).error ||
					i18n._(t`Failed to publish journey`),
			}
		}
		return { success: true }
	}

	if (intent === 'pause') {
		const res = await fetchTenant(`/operator/journeys/${journeyId}/pause`, {
			method: 'POST',
		})
		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			return {
				error:
					(err as { error?: string }).error ||
					i18n._(t`Failed to pause journey`),
			}
		}
		return { success: true }
	}

	if (intent === 'delete') {
		const res = await fetchTenant(`/operator/journeys/${journeyId}`, {
			method: 'DELETE',
		})
		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			return {
				error:
					(err as { error?: string }).error ||
					i18n._(t`Failed to delete journey`),
			}
		}
		return { success: true }
	}

	if (intent === 'duplicate') {
		const getRes = await fetchTenant(`/operator/journeys/${journeyId}`)
		if (!getRes.ok) return { error: i18n._(t`Failed to find original journey`) }
		const orig = (await getRes.json()) as {
			journey?: {
				name?: string
				description?: string
				triggerType?: string
				nodes?: unknown[]
				edges?: unknown[]
				graphJson?: unknown
			}
		}

		const journeyName = orig.journey?.name || i18n._(t`Journey`)
		const createRes = await fetchTenant('/operator/journeys', {
			method: 'POST',
			body: JSON.stringify({
				name: i18n._(t`${journeyName} (Copy)`),
				description: orig.journey?.description,
				triggerType: orig.journey?.triggerType,
				nodes: orig.journey?.nodes || [],
				edges: orig.journey?.edges || [],
				graphJson: orig.journey?.graphJson,
			}),
		})

		if (!createRes.ok) {
			const err = await createRes.json().catch(() => ({}))
			return {
				error:
					(err as { error?: string }).error ||
					i18n._(t`Failed to duplicate journey`),
			}
		}

		const created = (await createRes.json()) as { journey?: { id?: string } }
		return redirect(
			`/${orgSlug}/marketing/automations/${created.journey?.id || ''}`,
		)
	}

	return { error: i18n._(t`Unknown intent`) }
}

export default function JourneysList() {
	const { _ } = useLingui()
	const { journeys, orgSlug, error } = useLoaderData<typeof loader>()
	const fetcher = useFetcher()
	const [searchQuery, setSearchQuery] = useState('')
	const [statusFilter, setStatusFilter] = useState<string>('all')

	const statusFilterLabels: Record<(typeof STATUS_FILTERS)[number], string> = {
		all: _(msg`All`),
		active: _(msg`Active`),
		draft: _(msg`Draft`),
		paused: _(msg`Paused`),
	}

	const filteredJourneys = journeys.filter((journey) => {
		const matchesSearch =
			journey.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			(journey.description &&
				journey.description.toLowerCase().includes(searchQuery.toLowerCase()))
		const matchesStatus =
			statusFilter === 'all' || journey.status === statusFilter
		return matchesSearch && matchesStatus
	})

	const hasFilters = searchQuery.length > 0 || statusFilter !== 'all'

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Automations`)}
				description={_(
					msg`Event-driven workflows with triggers, delays, and actions.`,
				)}
				actions={
					<Button
						render={<Link to={`/${orgSlug}/marketing/automations/new`} />}
						className="shrink-0 gap-2"
					>
						<Icon name="plus" className="size-4" />
						{_(msg`New automation`)}
					</Button>
				}
			/>

			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="relative max-w-sm flex-1">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
					/>
					<Input
						placeholder={_(msg`Search automations...`)}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="h-9 pl-9"
					/>
				</div>
				<div className="flex flex-wrap items-center gap-1">
					{STATUS_FILTERS.map((status) => (
						<button
							key={status}
							type="button"
							onClick={() => setStatusFilter(status)}
							className={cn(
								'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
								statusFilter === status
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							{statusFilterLabels[status]}
						</button>
					))}
				</div>
			</div>

			{error ? (
				<p className="text-destructive text-sm">{error}</p>
			) : filteredJourneys.length === 0 ? (
				<EmptyState
					title={_(msg`No automations found`)}
					description={
						hasFilters
							? _(msg`Try adjusting your search or filter.`)
							: _(msg`Create your first marketing automation.`)
					}
					icons={['play', 'route', 'clock']}
					action={
						!hasFilters
							? {
									label: _(msg`Create automation`),
									href: `/${orgSlug}/marketing/automations/new`,
								}
							: undefined
					}
				/>
			) : (
				<ItemGroup>
					{filteredJourneys.map((journey) => {
						const stepCount = journey.stepCount
						const runsCount = journey.runsCount
						const journeyName = journey.name

						return (
							<Item key={journey.id} variant="outline" size="sm">
								<ItemContent>
									<Link
										to={`/${orgSlug}/marketing/automations/${journey.id}`}
										className="min-w-0"
									>
										<ItemTitle>{journey.name}</ItemTitle>
										<ItemDescription>
											<span className="capitalize">
												{formatTriggerType(journey.triggerType)}
											</span>
											{' · '}
											{_(msg`${stepCount} steps`)}
											{' · '}
											{_(msg`${runsCount} runs`)}
										</ItemDescription>
									</Link>
								</ItemContent>

								<ItemActions>
									<JourneyStatusBadge status={journey.status} />

									<Button
										render={
											<Link
												to={`/${orgSlug}/marketing/automations/${journey.id}/runs`}
											/>
										}
										variant="ghost"
										size="sm"
										className="text-muted-foreground size-8 p-0"
										title={_(msg`View run history`)}
									>
										<Icon name="clock" className="size-4" />
									</Button>

									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="sm"
													className="text-muted-foreground size-8 p-0"
													title={_(msg`More actions`)}
												>
													<Icon name="ellipsis" className="size-4" />
												</Button>
											}
										/>
										<DropdownMenuContent align="end">
											{journey.status === 'draft' ||
											journey.status === 'paused' ? (
												<DropdownMenuItem
													onClick={() => {
														void fetcher.submit(
															{ intent: 'publish', journeyId: journey.id },
															{ method: 'POST' },
														)
													}}
												>
													{_(msg`Publish`)}
												</DropdownMenuItem>
											) : journey.status === 'active' ? (
												<DropdownMenuItem
													onClick={() => {
														void fetcher.submit(
															{ intent: 'pause', journeyId: journey.id },
															{ method: 'POST' },
														)
													}}
												>
													{_(msg`Pause`)}
												</DropdownMenuItem>
											) : null}

											<DropdownMenuItem
												onClick={() => {
													void fetcher.submit(
														{ intent: 'duplicate', journeyId: journey.id },
														{ method: 'POST' },
													)
												}}
											>
												{_(msg`Duplicate`)}
											</DropdownMenuItem>

											<DropdownMenuItem
												className="text-destructive focus:text-destructive"
												onClick={() => {
													if (
														confirm(
															_(
																msg`Are you sure you want to delete "${journeyName}"?`,
															),
														)
													) {
														void fetcher.submit(
															{ intent: 'delete', journeyId: journey.id },
															{ method: 'POST' },
														)
													}
												}}
											>
												{_(msg`Delete`)}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</ItemActions>
							</Item>
						)
					})}
				</ItemGroup>
			)}
		</div>
	)
}
