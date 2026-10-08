import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
	callListSchema,
	type CallRequest,
	type CallSummary,
	FOLLOW_UP_LABELS,
	formatDateTime,
	formatPhone,
	formatRelative,
} from '#app/components/phone-agent/call-data.ts'
import { CallDetailPanel } from '#app/components/phone-agent/call-detail-sheet.tsx'
import {
	CallInsightBadges,
	type CallTagOption,
} from '#app/components/phone-agent/call-follow-up.tsx'
import { useVerticalLabels } from '#app/components/phone-agent/vertical-labels.ts'
import {
	phoneCallsErrorMessage,
	usePhoneCallsClient,
} from '#app/hooks/use-phone-calls.ts'

const PAGE_SIZE = 50

/**
 * Calls the phone agent marked as needing a person: callbacks, messages,
 * voicemails, failed transfers. The full call history stays in Phone agent →
 * Calls; this tab is the to-do list.
 */
export function CallsTab({
	orgSlug,
	scopeNames,
	canUpdate,
	canDelete,
	tags,
	onOpenCountChange,
}: {
	orgSlug: string
	scopeNames: Record<string, string>
	canUpdate: boolean
	canDelete: boolean
	tags: CallTagOption[]
	onOpenCountChange: (count: number) => void
}) {
	const { _, i18n } = useLingui()
	const labels = useVerticalLabels()
	const request = usePhoneCallsClient(orgSlug)
	const [calls, setCalls] = useState<CallSummary[]>([])
	const [openCount, setOpenCount] = useState<number | null>(null)
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
	const [revision, setRevision] = useState(0)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
	const [requestRevision, setRequestRevision] = useState(0)
	const [toggleError, setToggleError] = useState<string | null>(null)
	const pagedRef = useRef(false)
	const loadMoreRef = useRef<AbortController | null>(null)
	// Bumped on each local follow-up change so a list request that started
	// before it can't restore the old state.
	const localEditsRef = useRef(0)
	const selectedIdRef = useRef(selectedId)
	useEffect(() => {
		selectedIdRef.current = selectedId
	}, [selectedId])

	useEffect(() => {
		if (openCount !== null) onOpenCountChange(openCount)
	}, [openCount, onOpenCountChange])

	const query = useCallback((cursor?: string) => {
		const params = new URLSearchParams({
			followUp: 'open',
			limit: String(PAGE_SIZE),
		})
		if (cursor) params.set('cursor', cursor)
		return `/?${params}`
	}, [])

	useEffect(() => {
		const controller = new AbortController()
		loadMoreRef.current?.abort()
		loadMoreRef.current = null
		setLoadingMore(false)
		setLoading(true)
		setError(null)
		setLoadMoreError(null)
		const editsAtStart = localEditsRef.current
		void request(query(), { signal: controller.signal })
			.then((payload) => {
				if (controller.signal.aborted) return
				if (localEditsRef.current !== editsAtStart) {
					setRevision((value) => value + 1)
					return
				}
				const result = callListSchema.parse(payload)
				pagedRef.current = false
				// A call completed from this tab stays in view, marked complete,
				// until the operator moves on; the next refresh drops it.
				setCalls((current) => {
					const ids = new Set(result.calls.map((call) => call.id))
					const kept = current.filter(
						(call) =>
							call.id === selectedIdRef.current &&
							call.followUpStatus === 'resolved' &&
							!ids.has(call.id),
					)
					return [...kept, ...result.calls].sort((a, b) =>
						b.startedAt.localeCompare(a.startedAt),
					)
				})
				setNextCursor(result.nextCursor ?? null)
				setOpenCount(result.openFollowUps)
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
	}, [request, query, revision, _])

	const refresh = useCallback(() => setRevision((value) => value + 1), [])

	useEffect(() => {
		// Don't jump back to the first page while someone reads older calls.
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
			loadMoreRef.current?.abort()
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
				await request(query(nextCursor), { signal: controller.signal }),
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
		setPendingRequestId(callRequest.id)
		setToggleError(null)
		try {
			await request(`/requests/${encodeURIComponent(callRequest.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({
					status: callRequest.status === 'open' ? 'done' : 'open',
				}),
			})
			setRequestRevision((value) => value + 1)
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

	const removeCalls = (keep: (call: CallSummary) => boolean) => {
		setSelectedId(null)
		setCalls((current) => current.filter(keep))
		refresh()
	}

	const callerLabel = (call: CallSummary) =>
		call.channel === 'web_test'
			? _(msg`Test call`)
			: call.customerName ||
				formatPhone(call.callerPhone) ||
				_(msg`Unknown caller`)
	const count = openCount ?? 0

	return (
		<div className="bg-background flex min-h-0 flex-1 overflow-hidden">
			<section
				aria-label={_(msg`Calls that need follow-up`)}
				className={cn(
					'bg-muted/20 flex min-h-0 w-full shrink-0 flex-col border-e md:w-80 lg:w-96',
					selectedId && 'hidden md:flex',
				)}
			>
				<div className="flex items-center justify-between gap-2 border-b p-4">
					<p className="text-muted-foreground text-xs tabular-nums">
						<Trans>{count} need follow-up</Trans>
					</p>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Refresh calls`)}
							title={_(msg`Refresh calls`)}
							disabled={loading}
							onClick={refresh}
						>
							<Icon
								name="refresh-cw"
								className={cn(loading && 'animate-spin')}
							/>
						</Button>
						<Button
							variant="ghost"
							size="xs"
							render={<Link to={`/${orgSlug}/phone-agent/calls`} />}
						>
							<Trans>All calls</Trans>
						</Button>
					</div>
				</div>
				<ScrollArea className="min-h-0 flex-1" aria-busy={loading}>
					{loading && calls.length === 0 ? (
						<div
							className="space-y-6 p-5"
							role="status"
							aria-label={_(msg`Loading calls`)}
						>
							{[0, 1, 2, 3].map((key) => (
								<div key={key} className="space-y-2">
									<Skeleton className="h-4 w-2/3" />
									<Skeleton className="h-3 w-full" />
									<Skeleton className="h-3 w-1/3" />
								</div>
							))}
						</div>
					) : error ? (
						<div className="space-y-3 p-6">
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
							<Button variant="outline" size="sm" onClick={refresh}>
								<Trans>Try again</Trans>
							</Button>
						</div>
					) : calls.length === 0 ? (
						<div className="flex flex-col items-center px-6 py-16 text-center">
							<Icon
								name="phone"
								className="text-muted-foreground mb-4 size-8"
							/>
							<h2 className="font-medium">
								<Trans>No calls need follow-up</Trans>
							</h2>
							<p className="text-muted-foreground mt-2 text-sm">
								<Trans>
									When a caller asks for a callback, leaves a message, or needs
									help your agent couldn’t give, the call appears here.
								</Trans>
							</p>
						</div>
					) : (
						<ul className="divide-y">
							{calls.map((call) => {
								const resolved = call.followUpStatus === 'resolved'
								const scopeName = call.scopeId
									? scopeNames[call.scopeId]
									: undefined
								return (
									<li key={call.id}>
										<button
											type="button"
											className={cn(
												'hover:bg-muted/50 focus-visible:ring-ring w-full px-4 py-4 text-start focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
												selectedId === call.id && 'bg-muted',
											)}
											aria-pressed={selectedId === call.id}
											onClick={() => {
												setSelectedId(call.id)
												setToggleError(null)
											}}
										>
											<div className="flex items-start justify-between gap-3">
												<span
													className={cn(
														'min-w-0 truncate text-sm',
														!resolved && 'font-semibold',
													)}
												>
													{callerLabel(call)}
												</span>
												<time
													className="text-muted-foreground shrink-0 text-xs tabular-nums"
													dateTime={call.startedAt}
													title={formatDateTime(call.startedAt, i18n.locale)}
												>
													{formatRelative(call.startedAt, i18n.locale)}
												</time>
											</div>
											<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
												{resolved ? (
													<Badge variant="outline">
														<Icon name="check" />
														{_(FOLLOW_UP_LABELS.resolved)}
													</Badge>
												) : null}
												{call.purpose ? (
													<Badge variant="secondary">
														{labels.purposeLabel(call.purpose)}
													</Badge>
												) : null}
												<CallInsightBadges
													call={call}
													tags={tags}
													showFollowUp={false}
												/>
												{scopeName ? (
													<span className="text-muted-foreground truncate text-xs">
														{scopeName}
													</span>
												) : null}
											</div>
											<p className="text-muted-foreground mt-2 line-clamp-2 text-sm leading-relaxed">
												{call.summary || _(msg`No summary for this call.`)}
											</p>
										</button>
									</li>
								)
							})}
						</ul>
					)}
					{loadMoreError ? (
						<p role="alert" className="text-destructive px-4 pb-3 text-sm">
							{loadMoreError}
						</p>
					) : null}
				</ScrollArea>
				{nextCursor ? (
					<div className="flex justify-center border-t p-3">
						<Button
							variant="ghost"
							size="sm"
							disabled={loadingMore}
							onClick={() => void loadMore()}
						>
							{loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
						</Button>
					</div>
				) : null}
			</section>
			{selectedId ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{toggleError ? (
						<p role="alert" className="text-destructive px-5 pt-3 text-sm">
							{toggleError}
						</p>
					) : null}
					<CallDetailPanel
						callId={selectedId}
						request={request}
						scopeNames={scopeNames}
						canUpdate={canUpdate}
						canDelete={canDelete}
						tags={tags}
						onBack={() => setSelectedId(null)}
						onCallChanged={(callId, patch) => {
							localEditsRef.current += 1
							const before = calls.find((call) => call.id === callId)
							setCalls((current) =>
								current.map((call) =>
									call.id === callId ? { ...call, ...patch } : call,
								),
							)
							if (before && before.followUpStatus !== patch.followUpStatus) {
								setOpenCount((current) =>
									Math.max(
										0,
										(current ?? 0) + (patch.followUpStatus === 'open' ? 1 : -1),
									),
								)
							}
						}}
						onDeleted={(callId) => removeCalls((call) => call.id !== callId)}
						onCallerErased={(phone) =>
							removeCalls((call) => call.callerPhone !== phone)
						}
						onToggleRequest={
							canUpdate ? (entry) => void toggleRequest(entry) : undefined
						}
						pendingRequestId={pendingRequestId}
						requestRevision={requestRevision}
					/>
				</div>
			) : (
				<div className="hidden min-w-0 flex-1 flex-col items-center justify-center px-8 py-20 text-center md:flex">
					<Icon name="phone" className="text-muted-foreground mb-5 size-9" />
					<h2 className="text-lg font-medium">
						<Trans>Calls that need a person</Trans>
					</h2>
					<p className="text-muted-foreground mt-2 max-w-xs text-sm leading-relaxed">
						<Trans>
							Select a call to read the summary and transcript, call the
							customer back, and mark it complete.
						</Trans>
					</p>
				</div>
			)}
		</div>
	)
}
