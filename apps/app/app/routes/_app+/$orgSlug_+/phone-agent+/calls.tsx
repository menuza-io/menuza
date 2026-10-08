import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type CallPurpose } from '@repo/phone-agent'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLoaderData, useParams, useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	callListSchema,
	type CallRequest,
	callRequestListSchema,
	type CallSummary,
	formatDateTime,
	formatDuration,
	formatPhone,
	formatRelative,
	OUTCOME_LABELS,
	outcomeVariant,
} from '#app/components/phone-agent/call-data.ts'
import { CallDetailSheet } from '#app/components/phone-agent/call-detail-sheet.tsx'
import { CallInsightBadges } from '#app/components/phone-agent/call-follow-up.tsx'
import { CallRequestCard } from '#app/components/phone-agent/call-request-card.tsx'
import { useVerticalLabels } from '#app/components/phone-agent/vertical-labels.ts'
import {
	phoneCallsErrorMessage,
	usePhoneCallsClient,
} from '#app/hooks/use-phone-calls.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import { loadCallsViewData } from '#app/utils/phone-agent/calls-view.server.ts'
import { type Route } from './+types/calls.ts'

const PAGE_SIZE = 50

type PurposeFilter = CallPurpose | 'all'
type ChannelFilter = 'all' | 'phone' | 'web_test'
type FollowUpFilter = 'all' | 'open' | 'resolved'
type RequestStatusFilter = 'open' | 'done'

export async function loader({ request, params }: Route.LoaderArgs) {
	const { orgId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
	)
	return loadCallsViewData(request, orgId)
}

export default function PhoneAgentCallsRoute() {
	const { scopeNames, canUpdate, canDelete, tags } =
		useLoaderData<typeof loader>()
	const labels = useVerticalLabels()
	const { orgSlug = '' } = useParams()
	const [searchParams, setSearchParams] = useSearchParams()
	const { _, i18n } = useLingui()
	const request = usePhoneCallsClient(orgSlug)

	const [tab, setTab] = useState<'calls' | 'requests'>('calls')
	const [purpose, setPurpose] = useState<PurposeFilter>('all')
	const [channel, setChannel] = useState<ChannelFilter>('all')
	const [followUp, setFollowUp] = useState<FollowUpFilter>('all')
	const [tagFilter, setTagFilter] = useState<string>('all')
	const [openFollowUps, setOpenFollowUps] = useState(0)
	const [calls, setCalls] = useState<CallSummary[]>([])
	const [purposeCounts, setPurposeCounts] = useState<
		Partial<Record<CallPurpose, number>>
	>({})
	const [openRequests, setOpenRequests] = useState(0)
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const hasMore = nextCursor != null
	const [loading, setLoading] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
	const [revision, setRevision] = useState(0)
	const pagedRef = useRef(false)
	const loadMoreRef = useRef<AbortController | null>(null)

	const [requestStatus, setRequestStatus] =
		useState<RequestStatusFilter>('open')
	const [requests, setRequests] = useState<CallRequest[]>([])
	const [requestsLoading, setRequestsLoading] = useState(true)
	const [requestsError, setRequestsError] = useState<string | null>(null)
	const [requestsRevision, setRequestsRevision] = useState(0)
	const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
	const [toggleError, setToggleError] = useState<string | null>(null)

	// Staff alerts link here with ?call=<id>.
	const [selectedCallId, setSelectedCallId] = useState<string | null>(() =>
		searchParams.get('call'),
	)
	const selectCall = useCallback(
		(callId: string | null) => {
			setSelectedCallId(callId)
			if (!callId && searchParams.has('call')) {
				const next = new URLSearchParams(searchParams)
				next.delete('call')
				setSearchParams(next, { replace: true, preventScrollReset: true })
			}
		},
		[searchParams, setSearchParams],
	)

	const buildQuery = useCallback(
		(cursor?: string) => {
			const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
			if (purpose !== 'all') params.set('purpose', purpose)
			if (channel !== 'all') params.set('channel', channel)
			if (followUp !== 'all') params.set('followUp', followUp)
			if (tagFilter !== 'all') params.set('tag', tagFilter)
			if (cursor) params.set('cursor', cursor)
			return `/?${params}`
		},
		[purpose, channel, followUp, tagFilter],
	)

	useEffect(() => {
		const controller = new AbortController()
		// A page still loading for the previous filters must not be appended.
		loadMoreRef.current?.abort()
		loadMoreRef.current = null
		setLoadingMore(false)
		setLoading(true)
		setError(null)
		setLoadMoreError(null)
		void request(buildQuery(), { signal: controller.signal })
			.then((payload) => {
				if (controller.signal.aborted) return
				const result = callListSchema.parse(payload)
				pagedRef.current = false
				setCalls(result.calls)
				setNextCursor(result.nextCursor ?? null)
				setOpenRequests(result.openRequests)
				setOpenFollowUps(result.openFollowUps)
				setPurposeCounts(
					Object.fromEntries(
						result.purposeCounts.map((entry) => [
							entry.purpose ?? 'other',
							entry.total,
						]),
					),
				)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						phoneCallsErrorMessage(
							cause,
							_(msg`Unable to load calls. Try again.`),
						),
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [request, buildQuery, revision, _])

	useEffect(() => {
		const controller = new AbortController()
		setRequestsLoading(true)
		setRequestsError(null)
		void request(`/requests?status=${requestStatus}`, {
			signal: controller.signal,
		})
			.then((payload) => {
				if (!controller.signal.aborted)
					setRequests(callRequestListSchema.parse(payload).requests)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setRequestsError(
						phoneCallsErrorMessage(
							cause,
							_(msg`Unable to load requests. Try again.`),
						),
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setRequestsLoading(false)
			})
		return () => controller.abort()
	}, [request, requestStatus, requestsRevision, _])

	const refresh = useCallback(() => {
		setRevision((value) => value + 1)
		setRequestsRevision((value) => value + 1)
	}, [])

	useEffect(() => {
		// Skip background refreshes once older pages are loaded, so the list
		// doesn't jump back to the first page while someone is reading.
		const onFocus = () => {
			if (!pagedRef.current) refresh()
		}
		window.addEventListener('focus', onFocus)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') onFocus()
		}, 60_000)
		return () => {
			window.removeEventListener('focus', onFocus)
			window.clearInterval(timer)
		}
	}, [refresh])

	const loadMore = async () => {
		if (!nextCursor || loadingMore) return
		const controller = new AbortController()
		loadMoreRef.current = controller
		setLoadingMore(true)
		setLoadMoreError(null)
		try {
			const result = callListSchema.parse(
				await request(buildQuery(nextCursor), { signal: controller.signal }),
			)
			if (controller.signal.aborted) return
			pagedRef.current = true
			setCalls((current) => {
				const seen = new Set(current.map((call) => call.id))
				return [
					...current,
					...result.calls.filter((call) => !seen.has(call.id)),
				]
			})
			setNextCursor(result.nextCursor ?? null)
		} catch (cause) {
			if (controller.signal.aborted) return
			setLoadMoreError(
				phoneCallsErrorMessage(
					cause,
					_(msg`Unable to load more calls. Try again.`),
				),
			)
		} finally {
			if (loadMoreRef.current === controller) {
				loadMoreRef.current = null
				setLoadingMore(false)
			}
		}
	}

	const toggleRequest = async (callRequest: CallRequest) => {
		const status = callRequest.status === 'open' ? 'done' : 'open'
		setPendingRequestId(callRequest.id)
		setToggleError(null)
		try {
			await request(`/requests/${encodeURIComponent(callRequest.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ status }),
			})
			setRequests((current) =>
				current.filter((entry) => entry.id !== callRequest.id),
			)
			setOpenRequests((current) =>
				Math.max(0, current + (status === 'done' ? -1 : 1)),
			)
			setRequestsRevision((value) => value + 1)
		} catch (cause) {
			setToggleError(
				phoneCallsErrorMessage(
					cause,
					_(msg`Could not update this request. Try again.`),
				),
			)
		} finally {
			setPendingRequestId(null)
		}
	}

	const purposeItems = [
		{ value: 'all', label: _(msg`All purposes`) },
		...labels.purposes.map((entry) => ({
			value: entry.id,
			label: entry.label,
		})),
	]
	const channelItems = [
		{ value: 'all', label: _(msg`All calls`) },
		{ value: 'phone', label: _(msg`Phone`) },
		{ value: 'web_test', label: _(msg`Test calls`) },
	]
	const followUpItems = [
		{ value: 'all', label: _(msg`Any status`) },
		{ value: 'open', label: _(msg`Needs follow-up`) },
		{ value: 'resolved', label: _(msg`Complete`) },
	]
	const tagItems = [
		{ value: 'all', label: _(msg`All tags`) },
		...tags.map((tag) => ({ value: tag.id, label: tag.name })),
	]
	const filtered =
		purpose !== 'all' ||
		channel !== 'all' ||
		followUp !== 'all' ||
		tagFilter !== 'all'
	const callerLabel = (call: CallSummary) =>
		call.channel === 'web_test'
			? _(msg`Test call`)
			: call.customerName ||
				formatPhone(call.callerPhone) ||
				_(msg`Unknown caller`)

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={<Trans>Calls</Trans>}
				description={
					<Trans>
						Every call your agent answered, with summaries, transcripts, and
						follow-up requests.
					</Trans>
				}
				actions={
					<Button
						variant="outline"
						onClick={refresh}
						disabled={loading}
						aria-label={_(msg`Refresh calls`)}
					>
						<Icon name="refresh-cw" className={cn(loading && 'animate-spin')} />
						<Trans>Refresh</Trans>
					</Button>
				}
			/>

			<section
				aria-labelledby="purpose-summary-heading"
				className="flex flex-col gap-3"
			>
				<h2
					id="purpose-summary-heading"
					className="text-muted-foreground text-sm font-medium"
				>
					<Trans>Last 30 days</Trans>
				</h2>
				<div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-5">
					{labels.purposes.map(({ id: value, label }) => {
						const active = purpose === value
						return (
							<button
								key={value}
								type="button"
								aria-pressed={active}
								onClick={() => {
									setPurpose(active ? 'all' : value)
									setTab('calls')
								}}
								className={cn(
									'hover:bg-muted/50 focus-visible:ring-ring flex min-w-0 flex-col items-start gap-1 rounded-lg border p-3 text-start transition-colors focus-visible:ring-2 focus-visible:outline-none sm:p-4',
									active && 'border-primary bg-muted',
								)}
							>
								<span className="text-muted-foreground w-full truncate text-xs">
									{label}
								</span>
								<span className="text-xl font-semibold tabular-nums sm:text-2xl">
									{loading && calls.length === 0
										? '—'
										: (purposeCounts[value] ?? 0)}
								</span>
							</button>
						)
					})}
				</div>
			</section>

			<Tabs
				value={tab}
				onValueChange={(value) => setTab(value as 'calls' | 'requests')}
				className="gap-4"
			>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<TabsList aria-label={_(msg`Call views`)}>
						<TabsTrigger value="calls">
							<Trans>Calls</Trans>
							{openFollowUps > 0 ? (
								<Badge
									variant="secondary"
									aria-label={_(msg`${openFollowUps} need follow-up`)}
								>
									{openFollowUps}
								</Badge>
							) : null}
						</TabsTrigger>
						<TabsTrigger value="requests">
							<Trans>Requests</Trans>
							{openRequests > 0 ? (
								<Badge variant="secondary">{openRequests}</Badge>
							) : null}
						</TabsTrigger>
					</TabsList>
					{tab === 'calls' ? (
						<div className="flex flex-wrap items-center gap-2">
							<Select
								items={followUpItems}
								value={followUp}
								onValueChange={(value) => {
									if (value) setFollowUp(value as FollowUpFilter)
								}}
							>
								<SelectTrigger
									className="w-44"
									aria-label={_(msg`Filter by follow-up`)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{followUpItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{tags.length ? (
								<Select
									items={tagItems}
									value={tagFilter}
									onValueChange={(value) => {
										if (value) setTagFilter(value as string)
									}}
								>
									<SelectTrigger
										className="w-36"
										aria-label={_(msg`Filter by tag`)}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{tagItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : null}
							<Select
								items={purposeItems}
								value={purpose}
								onValueChange={(value) => {
									if (value) setPurpose(value as PurposeFilter)
								}}
							>
								<SelectTrigger
									className="w-40"
									aria-label={_(msg`Filter by purpose`)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{purposeItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select
								items={channelItems}
								value={channel}
								onValueChange={(value) => {
									if (value) setChannel(value as ChannelFilter)
								}}
							>
								<SelectTrigger
									className="w-36"
									aria-label={_(msg`Filter by channel`)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{channelItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : (
						<div className="flex items-center gap-1">
							<Button
								variant={requestStatus === 'open' ? 'secondary' : 'ghost'}
								size="sm"
								aria-pressed={requestStatus === 'open'}
								onClick={() => setRequestStatus('open')}
							>
								<Trans>Open</Trans>
							</Button>
							<Button
								variant={requestStatus === 'done' ? 'secondary' : 'ghost'}
								size="sm"
								aria-pressed={requestStatus === 'done'}
								onClick={() => setRequestStatus('done')}
							>
								<Trans>Done</Trans>
							</Button>
						</div>
					)}
				</div>

				<TabsContent value="calls" aria-busy={loading}>
					{loading && calls.length === 0 ? (
						<div
							className="flex flex-col gap-3"
							role="status"
							aria-label={_(msg`Loading calls`)}
						>
							{[0, 1, 2, 3, 4].map((key) => (
								<Skeleton key={key} className="h-16 w-full" />
							))}
						</div>
					) : error ? (
						<LoadError
							title={<Trans>Couldn't load calls</Trans>}
							detail={error}
							onRetry={() => setRevision((value) => value + 1)}
						/>
					) : calls.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Icon name="phone" />
								</EmptyMedia>
								<EmptyTitle>
									{filtered ? (
										<Trans>No matching calls</Trans>
									) : (
										<Trans>No calls yet</Trans>
									)}
								</EmptyTitle>
								<EmptyDescription>
									{filtered ? (
										<Trans>Try different filters.</Trans>
									) : (
										<Trans>
											Calls your agent answers will appear here. Try a test call
											from your browser to see how it sounds.
										</Trans>
									)}
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								{filtered ? (
									<Button
										variant="outline"
										onClick={() => {
											setPurpose('all')
											setChannel('all')
											setFollowUp('all')
											setTagFilter('all')
										}}
									>
										<Trans>Clear filters</Trans>
									</Button>
								) : (
									<Button render={<Link to={`/${orgSlug}/phone-agent/test`} />}>
										<Icon name="mic" />
										<Trans>Make a test call</Trans>
									</Button>
								)}
							</EmptyContent>
						</Empty>
					) : (
						<div className="flex flex-col gap-3">
							<ul className="divide-y rounded-lg border">
								{calls.map((call) => (
									<li key={call.id}>
										<button
											type="button"
											className="hover:bg-muted/50 focus-visible:ring-ring flex w-full flex-col gap-2 px-4 py-3 text-start focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
											onClick={() => selectCall(call.id)}
										>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<div className="flex min-w-0 items-center gap-2">
													<Icon
														name={
															call.channel === 'web_test' ? 'laptop' : 'phone'
														}
														className="text-muted-foreground size-4 shrink-0"
													/>
													<span className="min-w-0 truncate text-sm font-medium">
														{callerLabel(call)}
													</span>
												</div>
												<div className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums">
													<span>{formatDuration(call.durationSeconds)}</span>
													<time
														dateTime={call.startedAt}
														title={formatDateTime(call.startedAt, i18n.locale)}
													>
														{formatRelative(call.startedAt, i18n.locale)}
													</time>
												</div>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												{call.purpose ? (
													<Badge variant="secondary">
														{labels.purposeLabel(call.purpose)}
													</Badge>
												) : null}
												{call.outcome ? (
													<Badge variant={outcomeVariant(call.outcome)}>
														{_(OUTCOME_LABELS[call.outcome])}
													</Badge>
												) : null}
												<CallInsightBadges call={call} tags={tags} />
												{call.hasRecording ? (
													<Badge variant="outline">
														<Icon name="mic" />
														<Trans>Recorded</Trans>
													</Badge>
												) : null}
												{call.scopeId && scopeNames[call.scopeId] ? (
													<span className="text-muted-foreground text-xs">
														{scopeNames[call.scopeId]}
													</span>
												) : null}
											</div>
											{call.summary ? (
												<p className="text-muted-foreground line-clamp-1 text-sm">
													{call.summary}
												</p>
											) : null}
										</button>
									</li>
								))}
							</ul>
							{loadMoreError ? (
								<p role="alert" className="text-destructive text-sm">
									{loadMoreError}
								</p>
							) : null}
							{hasMore ? (
								<Button
									variant="outline"
									className="self-center"
									disabled={loadingMore}
									onClick={() => void loadMore()}
								>
									{loadingMore ? (
										<Trans>Loading…</Trans>
									) : (
										<Trans>Load more</Trans>
									)}
								</Button>
							) : null}
						</div>
					)}
				</TabsContent>

				<TabsContent value="requests" aria-busy={requestsLoading}>
					{toggleError ? (
						<p role="alert" className="text-destructive mb-3 text-sm">
							{toggleError}
						</p>
					) : null}
					{requestsLoading && requests.length === 0 ? (
						<div
							className="flex flex-col gap-3"
							role="status"
							aria-label={_(msg`Loading requests`)}
						>
							{[0, 1, 2].map((key) => (
								<Skeleton key={key} className="h-24 w-full" />
							))}
						</div>
					) : requestsError ? (
						<LoadError
							title={<Trans>Couldn't load requests</Trans>}
							detail={requestsError}
							onRetry={() => setRequestsRevision((value) => value + 1)}
						/>
					) : requests.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Icon name="check" />
								</EmptyMedia>
								<EmptyTitle>
									{requestStatus === 'open' ? (
										<Trans>No open requests</Trans>
									) : (
										<Trans>No completed requests</Trans>
									)}
								</EmptyTitle>
								<EmptyDescription>
									<Trans>
										Callbacks, complaints, and other requests your agent takes
										will appear here.
									</Trans>
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="flex flex-col gap-3">
							{requests.map((callRequest) => (
								<CallRequestCard
									key={callRequest.id}
									request={callRequest}
									pending={pendingRequestId === callRequest.id}
									onToggleStatus={
										canUpdate ? (entry) => void toggleRequest(entry) : undefined
									}
									onOpenCall={selectCall}
								/>
							))}
						</div>
					)}
				</TabsContent>
			</Tabs>

			<CallDetailSheet
				callId={selectedCallId}
				request={request}
				scopeNames={scopeNames}
				canUpdate={canUpdate}
				canDelete={canDelete}
				onClose={() => selectCall(null)}
				tags={tags}
				onCallChanged={(callId, patch) => {
					setCalls((current) =>
						current.map((call) =>
							call.id === callId ? { ...call, ...patch } : call,
						),
					)
					const before = calls.find((call) => call.id === callId)
					if (before && before.followUpStatus !== patch.followUpStatus) {
						setOpenFollowUps((count) =>
							Math.max(0, count + (patch.followUpStatus === 'open' ? 1 : -1)),
						)
					}
				}}
				onDeleted={(callId) => {
					selectCall(null)
					setCalls((current) => current.filter((call) => call.id !== callId))
					refresh()
				}}
				onCallerErased={(phone) => {
					selectCall(null)
					setCalls((current) =>
						current.filter((call) => call.callerPhone !== phone),
					)
					refresh()
				}}
				onToggleRequest={
					canUpdate ? (entry) => void toggleRequest(entry) : undefined
				}
				pendingRequestId={pendingRequestId}
				requestRevision={requestsRevision}
			/>
		</div>
	)
}

function LoadError({
	title,
	detail,
	onRetry,
}: {
	title: React.ReactNode
	detail: string
	onRetry: () => void
}) {
	return (
		<div
			role="alert"
			className="flex flex-col items-start gap-3 rounded-lg border p-6"
		>
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-muted-foreground text-sm">{detail}</p>
			</div>
			<Button variant="outline" size="sm" onClick={onRetry}>
				<Icon name="refresh-cw" />
				<Trans>Try again</Trans>
			</Button>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
