import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import { type ReactNode, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { z } from 'zod'
import { phoneCallsErrorMessage } from '#app/hooks/use-phone-calls.ts'
import {
	type CallDetail,
	callDetailSchema,
	type CallRequest,
	formatDateTime,
	formatDuration,
	formatPhone,
	OUTCOME_LABELS,
	outcomeVariant,
} from './call-data.ts'
import { CallFollowUpPanel, type CallTagOption } from './call-follow-up.tsx'
import { CallRequestCard } from './call-request-card.tsx'
import { useVerticalLabels } from './vertical-labels.ts'
import { phoneAgentVerticalUi } from './vertical-ui.tsx'

type CallsClient = (path: string, init?: RequestInit) => Promise<unknown>

const eraseResultSchema = z.object({
	callsDeleted: z.number().int().min(0).catch(0),
	requestsDeleted: z.number().int().min(0).catch(0),
	smsLogsDeleted: z.number().int().min(0).catch(0),
	recordingsQueued: z.number().int().min(0).catch(0),
})

type CallAuditEvent =
	| { event: 'call_deleted'; callId: string }
	| ({ event: 'caller_erased'; phoneLast4: string } & z.infer<
			typeof eraseResultSchema
	  >)

/**
 * Records a deletion in App's audit log after tenant-api has done it. Never
 * blocks the UI: the data is already gone, so a failed write is only logged.
 */
function reportCallAudit(orgSlug: string | undefined, event: CallAuditEvent) {
	if (!orgSlug) return
	void fetch(`/${encodeURIComponent(orgSlug)}/phone-agent/calls-audit`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(event),
	})
		.then((response) => {
			if (!response.ok) {
				console.error('Phone call audit failed', response.status)
			}
		})
		.catch((cause: unknown) => {
			console.error('Phone call audit failed', cause)
		})
}

const HANDOFFS_TITLE = phoneAgentVerticalUi.handoffsTitle ?? msg`Links sent`

const HandoffDetails = phoneAgentVerticalUi.HandoffDetails

function SentTo({ phone }: { phone: string }) {
	const formatted = formatPhone(phone)
	return <Trans>Sent to {formatted}</Trans>
}

function OpenedAt({ value }: { value: string }) {
	const { i18n } = useLingui()
	const openedAt = formatDateTime(value, i18n.locale)
	return <Trans>Opened {openedAt}</Trans>
}

type CallDetailProps = {
	callId: string | null
	request: CallsClient
	scopeNames: Record<string, string>
	/** Can complete, reopen, and tag calls and requests. */
	canUpdate: boolean
	canDelete: boolean
	onDeleted: (callId: string) => void
	/** Every call, request, text, and recording from this phone was erased. */
	onCallerErased: (phone: string) => void
	/** Omit to show requests without the complete/reopen action. */
	onToggleRequest?: (request: CallRequest) => void
	pendingRequestId: string | null
	requestRevision: number
	tags?: CallTagOption[]
	onCallChanged?: (
		callId: string,
		patch: Pick<CallDetail['call'], 'followUpStatus' | 'tags'>,
	) => void
}

type CallDetailFrame = (parts: {
	call: CallDetail['call'] | null
	title: ReactNode
	description: ReactNode
	body: ReactNode
}) => ReactNode

/** Call details in a side sheet, used by the call history page. */
export function CallDetailSheet({
	onClose,
	...props
}: CallDetailProps & { onClose: () => void }) {
	return (
		<Sheet
			open={props.callId !== null}
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<CallDetailView
				{...props}
				frame={({ title, description, body }) => (
					<SheetContent className="w-full sm:max-w-xl">
						<SheetHeader>
							<SheetTitle>{title}</SheetTitle>
							<SheetDescription>{description}</SheetDescription>
						</SheetHeader>
						<ScrollArea className="min-h-0 flex-1">
							<div className="flex flex-col gap-6 px-4 pb-6">{body}</div>
						</ScrollArea>
					</SheetContent>
				)}
			/>
		</Sheet>
	)
}

/** Call details beside a list, used by the mailbox. */
export function CallDetailPanel({
	onBack,
	...props
}: CallDetailProps & { callId: string; onBack: () => void }) {
	const { _ } = useLingui()
	return (
		<CallDetailView
			{...props}
			frame={({ call, title, description, body }) => (
				<section
					aria-label={_(msg`Call details`)}
					className="flex min-h-0 min-w-0 flex-1 flex-col"
				>
					<header className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
						<div className="flex min-w-0 items-center gap-2">
							<Button
								variant="ghost"
								size="icon-sm"
								className="md:hidden"
								aria-label={_(msg`Back to calls`)}
								onClick={onBack}
							>
								<Icon name="arrow-left" className="rtl:rotate-180" />
							</Button>
							<div className="min-w-0">
								<h2 className="truncate font-medium">{title}</h2>
								<p className="text-muted-foreground truncate text-xs">
									{description}
								</p>
							</div>
						</div>
						{call?.channel === 'phone' && call.callerPhone ? (
							<Button size="sm" render={<a href={`tel:${call.callerPhone}`} />}>
								<Icon name="phone" />
								<Trans>Call back</Trans>
							</Button>
						) : null}
					</header>
					<ScrollArea className="min-h-0 flex-1">
						<div className="flex flex-col gap-6 px-5 py-6 md:px-7">{body}</div>
					</ScrollArea>
				</section>
			)}
		/>
	)
}

function CallDetailView({
	callId,
	request,
	scopeNames,
	canUpdate,
	canDelete,
	onDeleted,
	onCallerErased,
	onToggleRequest,
	pendingRequestId,
	requestRevision,
	tags = [],
	onCallChanged,
	frame,
}: CallDetailProps & { frame: CallDetailFrame }) {
	const { _, i18n } = useLingui()
	const labels = useVerticalLabels()
	const { orgSlug } = useParams()
	const [detail, setDetail] = useState<CallDetail | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [revision, setRevision] = useState(0)
	const [confirmDelete, setConfirmDelete] = useState<'call' | 'caller' | null>(
		null,
	)
	const [deleting, setDeleting] = useState(false)
	const [deleteError, setDeleteError] = useState<string | null>(null)

	useEffect(() => {
		if (!callId) {
			setDetail(null)
			return
		}
		const controller = new AbortController()
		setLoading(true)
		setError(null)
		void request(`/${encodeURIComponent(callId)}`, {
			signal: controller.signal,
		})
			.then((payload) => {
				if (!controller.signal.aborted)
					setDetail(callDetailSchema.parse(payload))
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						phoneCallsErrorMessage(
							cause,
							_(msg`Unable to load this call. Try again.`),
						),
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [callId, request, revision, requestRevision, _])

	const deleteCall = async () => {
		if (!callId) return
		setDeleting(true)
		setDeleteError(null)
		try {
			await request(`/${encodeURIComponent(callId)}`, { method: 'DELETE' })
			reportCallAudit(orgSlug, { event: 'call_deleted', callId })
			setConfirmDelete(null)
			onDeleted(callId)
		} catch (cause) {
			setDeleteError(
				phoneCallsErrorMessage(
					cause,
					_(msg`Could not delete this call. Try again.`),
				),
			)
		} finally {
			setDeleting(false)
		}
	}

	const call = detail?.call.id === callId ? detail.call : null
	const erasablePhone =
		call?.channel === 'phone' ? (call.callerPhone ?? null) : null
	const erasePhoneLabel = formatPhone(erasablePhone)

	const eraseCaller = async () => {
		if (!erasablePhone) return
		setDeleting(true)
		setDeleteError(null)
		try {
			const result = await request('/erase', {
				method: 'POST',
				body: JSON.stringify({ phone: erasablePhone }),
			})
			const counts = eraseResultSchema.safeParse(result)
			reportCallAudit(orgSlug, {
				event: 'caller_erased',
				phoneLast4: erasablePhone.replace(/\D/gu, '').slice(-4),
				...(counts.success
					? counts.data
					: {
							callsDeleted: 0,
							requestsDeleted: 0,
							smsLogsDeleted: 0,
							recordingsQueued: 0,
						}),
			})
			setConfirmDelete(null)
			onCallerErased(erasablePhone)
		} catch (cause) {
			setDeleteError(
				phoneCallsErrorMessage(
					cause,
					_(msg`Could not erase this caller's data. Try again.`),
				),
			)
		} finally {
			setDeleting(false)
		}
	}

	const caller =
		call?.channel === 'web_test'
			? _(msg`Test call`)
			: call?.customerName ||
				formatPhone(call?.callerPhone) ||
				_(msg`Unknown caller`)

	const title = call ? caller : _(msg`Call details`)
	const description = call ? (
		<>
			{formatDateTime(call.startedAt, i18n.locale)}
			{' · '}
			{formatDuration(call.durationSeconds)}
			{call.scopeId && scopeNames[call.scopeId]
				? ` · ${scopeNames[call.scopeId]}`
				: null}
		</>
	) : (
		<Trans>Loading call…</Trans>
	)
	const body = (
		<>
			{loading && !call ? (
				<div
					className="flex flex-col gap-3"
					role="status"
					aria-label={_(msg`Loading call`)}
				>
					<Skeleton className="h-4 w-1/2" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-4 w-2/3" />
					<Skeleton className="h-4 w-1/3" />
				</div>
			) : error ? (
				<div className="flex flex-col items-start gap-3">
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setRevision((value) => value + 1)}
					>
						<Trans>Try again</Trans>
					</Button>
				</div>
			) : call && detail ? (
				<>
					<div className="flex flex-wrap gap-2">
						{call.channel === 'web_test' ? (
							<Badge variant="outline">
								<Icon name="laptop" />
								<Trans>Test call</Trans>
							</Badge>
						) : call.callerPhone ? (
							<Badge variant="outline">
								<Icon name="phone" />
								{formatPhone(call.callerPhone)}
							</Badge>
						) : null}
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
					</div>

					{call.channel === 'phone' || call.followUpStatus === 'open' ? (
						<CallFollowUpPanel
							call={call}
							tags={tags}
							canUpdate={canUpdate}
							request={request}
							onChanged={(patch) => {
								setDetail((current) =>
									current
										? { ...current, call: { ...current.call, ...patch } }
										: current,
								)
								onCallChanged?.(call.id, patch)
							}}
						/>
					) : null}

					<section className="flex flex-col gap-2">
						<h3 className="text-sm font-medium">
							<Trans>Summary</Trans>
						</h3>
						<p className="text-muted-foreground text-sm leading-relaxed">
							{call.summary || _(msg`No summary for this call.`)}
						</p>
					</section>

					{call.hasRecording ? (
						<section className="flex items-center gap-2 text-sm">
							<Badge variant="outline">
								<Icon name="mic" />
								<Trans>Recorded</Trans>
							</Badge>
							<span className="text-muted-foreground">
								<Trans>Playback coming soon.</Trans>
							</span>
						</section>
					) : null}

					<section className="flex flex-col gap-2">
						<h3 className="text-sm font-medium">
							<Trans>Transcript</Trans>
						</h3>
						{call.transcript?.length ? (
							<ol className="flex flex-col gap-2">
								{call.transcript.map((turn, index) => (
									<li
										key={index}
										className={cn(
											'flex max-w-[85%] flex-col gap-1 rounded-lg px-3 py-2 text-sm',
											turn.role === 'agent'
												? 'bg-muted self-start'
												: 'bg-primary text-primary-foreground self-end',
										)}
									>
										<span className="text-xs opacity-70">
											{turn.role === 'agent' ? (
												<Trans>Agent</Trans>
											) : (
												<Trans>Caller</Trans>
											)}
											{turn.at != null ? ` · ${formatDuration(turn.at)}` : null}
										</span>
										<span className="leading-relaxed whitespace-pre-wrap">
											{turn.text}
										</span>
									</li>
								))}
							</ol>
						) : (
							<p className="text-muted-foreground text-sm">
								<Trans>No transcript was saved for this call.</Trans>
							</p>
						)}
					</section>

					{detail.handoffs.length ? (
						<section className="flex flex-col gap-2">
							<h3 className="text-sm font-medium">{_(HANDOFFS_TITLE)}</h3>
							{detail.handoffs.map((handoff) => (
								<div
									key={handoff.id}
									className="flex flex-col gap-2 rounded-lg border p-4 text-sm"
								>
									{HandoffDetails ? <HandoffDetails handoff={handoff} /> : null}
									<div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
										{handoff.sentToPhone ? (
											<span className="flex items-center gap-1">
												<Icon name="smartphone" className="size-3.5" />
												<SentTo phone={handoff.sentToPhone} />
											</span>
										) : null}
										<span className="flex items-center gap-1">
											{handoff.openedAt ? (
												<>
													<Icon name="check" className="size-3.5" />
													<OpenedAt value={handoff.openedAt} />
												</>
											) : (
												<>
													<Icon name="clock" className="size-3.5" />
													<Trans>Not opened yet</Trans>
												</>
											)}
										</span>
									</div>
								</div>
							))}
						</section>
					) : null}

					{detail.requests.length ? (
						<section className="flex flex-col gap-2">
							<h3 className="text-sm font-medium">
								<Trans>Requests</Trans>
							</h3>
							{detail.requests.map((callRequest) => (
								<CallRequestCard
									key={callRequest.id}
									request={callRequest}
									pending={pendingRequestId === callRequest.id}
									onToggleStatus={onToggleRequest}
								/>
							))}
						</section>
					) : null}

					{canDelete ? (
						<section className="flex flex-wrap items-center gap-2 border-t pt-4">
							<Button
								variant="destructive"
								size="sm"
								onClick={() => setConfirmDelete('call')}
							>
								<Icon name="trash-2" />
								<Trans>Delete call</Trans>
							</Button>
							{erasablePhone ? (
								<Button
									variant="outline"
									size="sm"
									onClick={() => setConfirmDelete('caller')}
								>
									<Icon name="user" />
									<Trans>Erase caller's data</Trans>
								</Button>
							) : null}
						</section>
					) : null}
				</>
			) : null}
		</>
	)

	return (
		<>
			{frame({ call, title, description, body })}
			<AlertDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => {
					if (!open && !deleting) {
						setConfirmDelete(null)
						setDeleteError(null)
					}
				}}
			>
				<AlertDialogContent>
					{confirmDelete === 'caller' ? (
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Erase all data for this caller?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									Every call from {erasePhoneLabel} is permanently deleted, with
									its transcripts, recordings, texted links, requests, and text
									message history. Use this when a caller asks you to delete
									their data. This cannot be undone.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
					) : (
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete this call?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									The transcript, summary, recording, texted links, and requests
									from this call are permanently deleted. This cannot be undone.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
					)}
					{deleteError ? (
						<p role="alert" className="text-destructive text-sm">
							{deleteError}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={deleting}
							onClick={() =>
								void (confirmDelete === 'caller' ? eraseCaller() : deleteCall())
							}
						>
							{deleting ? (
								<Trans>Deleting…</Trans>
							) : confirmDelete === 'caller' ? (
								<Trans>Erase data</Trans>
							) : (
								<Trans>Delete call</Trans>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
