import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Separator } from '@repo/ui/separator'
import { useState, type FormEvent } from 'react'
import { TextAreaField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import {
	addApplicantNote,
	removeApplicantNote,
	updateInterview,
} from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import {
	type ApplicantAnswer,
	type ApplicantDetail,
	type ApplicantInterview,
	type ApplicantNote,
	type ApplicantTimelineEvent,
} from '#app/utils/hiring/applicant-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { type ApplicantLabels } from './applicant-labels.ts'

/** One labelled line in the details list. */
export function Fact({
	label,
	children,
}: {
	label: string
	children: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-4">
			<dt className="text-muted-foreground w-28 shrink-0 text-sm">{label}</dt>
			<dd className="min-w-0 text-sm break-words">{children}</dd>
		</div>
	)
}

/** Email and phone as links a phone will act on; the number reads left to right. */
export function ContactFacts({ detail }: { detail: ApplicantDetail }) {
	const { _ } = useLingui()
	return (
		<dl className="flex flex-col">
			<Fact label={_(t`Email`)}>
				{detail.email ? (
					<a
						href={`mailto:${detail.email}`}
						className="underline underline-offset-4"
					>
						<bdi dir="ltr">{detail.email}</bdi>
					</a>
				) : (
					<span className="text-muted-foreground">
						<Trans>Not given</Trans>
					</span>
				)}
			</Fact>
			<Separator />
			<Fact label={_(t`Phone`)}>
				{detail.phone ? (
					<a
						href={`tel:${detail.phone}`}
						className="underline underline-offset-4"
					>
						<bdi dir="ltr">{detail.phone}</bdi>
					</a>
				) : (
					<span className="text-muted-foreground">
						<Trans>Not given</Trans>
					</span>
				)}
			</Fact>
		</dl>
	)
}

/**
 * What the applicant answered, as they were asked. A dealbreaker that differs
 * from what the job wanted says so in words ("Wanted: Yes"), never by colour
 * alone, and it only flags: nothing is rejected automatically.
 */
export function AnswersList({ answers }: { answers: ApplicantAnswer[] }) {
	const { _ } = useLingui()
	if (answers.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>This job had no screening questions.</Trans>
			</p>
		)
	}
	return (
		<ItemGroup>
			{answers.map((answer) => {
				const differs =
					answer.kind === 'yes_no' && answer.answer !== answer.requiredAnswer
				return (
					<Item key={answer.id} variant="outline" render={<li />}>
						<div className="flex w-full flex-col gap-1">
							<p className="text-muted-foreground text-sm">{answer.prompt}</p>
							{answer.kind === 'yes_no' ? (
								<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
									<span className="font-medium">
										{answer.answer === 'yes' ? _(t`Yes`) : _(t`No`)}
									</span>
									{differs ? (
										<span className="text-destructive inline-flex items-center gap-1 text-xs">
											<Icon
												name="alert-triangle"
												className="size-3.5 shrink-0"
											/>
											{answer.dealbreaker
												? answer.requiredAnswer === 'yes'
													? _(t`Wanted: Yes. This one matters for the job.`)
													: _(t`Wanted: No. This one matters for the job.`)
												: answer.requiredAnswer === 'yes'
													? _(t`Wanted: Yes`)
													: _(t`Wanted: No`)}
										</span>
									) : null}
								</p>
							) : (
								<p className="text-sm break-words whitespace-pre-wrap">
									{answer.answer}
								</p>
							)}
						</div>
					</Item>
				)
			})}
		</ItemGroup>
	)
}

export function InterviewList({
	client,
	applicationId,
	interviews,
	labels,
	timeZoneOf,
	canWrite,
	onEdit,
	onChanged,
}: {
	client: StaffClient
	applicationId: string
	interviews: ApplicantInterview[]
	labels: ApplicantLabels
	timeZoneOf: (scopeId: string | null) => string | null
	canWrite: boolean
	onEdit: (interview: ApplicantInterview) => void
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const action = useStaffAction(describeApplicantError)

	async function change(
		interview: ApplicantInterview,
		body: Parameters<typeof updateInterview>[3],
	) {
		const result = await action.run(() =>
			updateInterview(client, applicationId, interview.id, body),
		)
		if (result.ok) onChanged()
	}

	if (interviews.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>No interviews yet.</Trans>
			</p>
		)
	}
	return (
		<div className="flex flex-col gap-2">
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<ItemGroup>
				{interviews.map((interview) => {
					const open = interview.status === 'scheduled'
					const when = labels.formatWhen(
						interview.scheduledAt,
						timeZoneOf(interview.scopeId),
					)
					const minutes = interview.durationMinutes
					return (
						<Item key={interview.id} variant="outline" render={<li />}>
							<div className="flex w-full items-start gap-2">
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<p className="text-sm font-medium">{when}</p>
									<p className="text-muted-foreground text-sm">
										{labels.mode[interview.mode]} · {_(t`${minutes} minutes`)} ·{' '}
										{labels.interviewStatus[interview.status]}
									</p>
									{interview.details ? (
										<p className="text-sm break-words whitespace-pre-wrap">
											{interview.details}
										</p>
									) : null}
									<p className="text-muted-foreground text-xs">
										{labels.invite[interview.inviteStatus]}
									</p>
									{interview.outcome ? (
										<p className="text-sm break-words whitespace-pre-wrap">
											<span className="text-muted-foreground">
												<Trans>How it went:</Trans>
											</span>{' '}
											{interview.outcome}
										</p>
									) : null}
								</div>
								{canWrite ? (
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="size-11 shrink-0 md:size-8"
													aria-label={_(t`Interview actions for ${when}`)}
													disabled={action.pending}
												>
													<Icon name="ellipsis" />
												</Button>
											}
										/>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onClick={() => onEdit(interview)}>
												<Icon name="pencil" />
												<Trans>Change time or details</Trans>
											</DropdownMenuItem>
											{open ? (
												<>
													<DropdownMenuItem
														onClick={() =>
															void change(interview, { status: 'completed' })
														}
													>
														<Icon name="check" />
														<Trans>Mark as done</Trans>
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() =>
															void change(interview, { status: 'no_show' })
														}
													>
														<Icon name="x" />
														<Trans>They did not show</Trans>
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() =>
															void change(interview, { resendInvite: true })
														}
													>
														<Icon name="mail" />
														<Trans>Email the invitation again</Trans>
													</DropdownMenuItem>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														onClick={() =>
															void change(interview, { status: 'cancelled' })
														}
													>
														<Icon name="ban" />
														<Trans>Cancel interview</Trans>
													</DropdownMenuItem>
												</>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>
								) : null}
							</div>
						</Item>
					)
				})}
			</ItemGroup>
		</div>
	)
}

export function NotesPanel({
	client,
	applicationId,
	notes,
	userId,
	canWrite,
	labels,
	onChanged,
}: {
	client: StaffClient
	applicationId: string
	notes: ApplicantNote[]
	userId: string
	canWrite: boolean
	labels: ApplicantLabels
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const action = useStaffAction(describeApplicantError)
	const [body, setBody] = useState('')

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!body.trim() || action.pending) return
		const result = await action.run(() =>
			addApplicantNote(client, applicationId, body.trim()),
		)
		if (result.ok) {
			setBody('')
			onChanged()
		}
	}
	async function remove(note: ApplicantNote) {
		const result = await action.run(() =>
			removeApplicantNote(client, applicationId, note.id),
		)
		if (result.ok) onChanged()
	}

	return (
		<div className="flex flex-col gap-4">
			{canWrite ? (
				<form onSubmit={(event) => void add(event)} className="grid gap-2">
					<TextAreaField
						label={<Trans>Add a note</Trans>}
						value={body}
						onChange={(event) => setBody(event.target.value)}
						maxLength={2000}
						rows={3}
						hint={_(t`Only your team sees notes. The applicant never does.`)}
						error={action.issues.body}
					/>
					<Button
						type="submit"
						className="h-11 self-start"
						disabled={action.pending || !body.trim()}
					>
						<Trans>Add note</Trans>
					</Button>
				</form>
			) : null}
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			{notes.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No notes yet.</Trans>
				</p>
			) : (
				<ItemGroup>
					{notes.map((note) => (
						<Item key={note.id} variant="outline" render={<li />}>
							<div className="flex w-full items-start gap-2">
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<p className="text-sm break-words whitespace-pre-wrap">
										{note.body}
									</p>
									<p className="text-muted-foreground text-xs">
										{note.authorId === userId ? _(t`You`) : _(t`A teammate`)} ·{' '}
										{labels.formatDay(note.createdAt)}
									</p>
								</div>
								{canWrite ? (
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-11 shrink-0 md:size-8"
										aria-label={_(t`Remove this note`)}
										disabled={action.pending}
										onClick={() => void remove(note)}
									>
										<Icon name="trash-2" />
									</Button>
								) : null}
							</div>
						</Item>
					))}
				</ItemGroup>
			)}
		</div>
	)
}

export function Timeline({
	events,
	labels,
}: {
	events: ApplicantTimelineEvent[]
	labels: ApplicantLabels
}) {
	const { _ } = useLingui()

	function describe(event: ApplicantTimelineEvent): string {
		const from = event.fromStage ? labels.stage[event.fromStage] : null
		const to = event.toStage ? labels.stage[event.toStage] : null
		switch (event.kind) {
			case 'applied':
				return _(t`Applied`)
			case 'stage_changed':
				return from && to
					? _(t`Moved from ${from} to ${to}`)
					: _(t`Stage changed`)
			case 'reopened':
				return to
					? _(t`Moved back into the pipeline, to ${to}`)
					: _(t`Moved back into the pipeline`)
			case 'note_added':
				return _(t`A note was added`)
			case 'interview_scheduled':
				return _(t`An interview was scheduled`)
			case 'interview_updated':
				return event.detail === 'completed'
					? _(t`An interview was marked done`)
					: event.detail === 'cancelled'
						? _(t`An interview was cancelled`)
						: event.detail === 'no_show'
							? _(t`They did not show for an interview`)
							: event.detail === 'rescheduled'
								? _(t`An interview was moved`)
								: _(t`An interview was updated`)
			case 'invite_sent': {
				const outcome = event.detail ?? ''
				if (outcome === 'sent') return _(t`Interview invitation emailed`)
				if (outcome === 'cancellation_sent') {
					return _(t`Interview cancellation emailed`)
				}
				if (outcome === 'no_email') {
					return _(t`No invitation sent: no email on file`)
				}
				if (outcome === 'email_disabled') {
					return _(t`No invitation sent: email is turned off`)
				}
				return _(t`The interview invitation could not be sent`)
			}
			case 'declined': {
				const reason = event.detail
				const label =
					reason && reason in labels.declineReason
						? labels.declineReason[reason as keyof typeof labels.declineReason]
						: null
				return label ? _(t`Declined: ${label}`) : _(t`Declined`)
			}
			case 'decline_email_sent':
				return event.detail === 'sent'
					? _(t`Decline message emailed`)
					: event.detail === 'no_email'
						? _(t`No message sent: no email on file`)
						: event.detail === 'email_disabled'
							? _(t`No message sent: email is turned off`)
							: _(t`The decline message could not be sent`)
			case 'hired':
				return _(t`Hired`)
		}
	}

	return (
		<ItemGroup>
			{events.map((event) => (
				<Item key={event.id} variant="outline" render={<li />}>
					<div className="flex w-full items-baseline justify-between gap-3 text-sm">
						<span className="min-w-0">{describe(event)}</span>
						<span className="text-muted-foreground shrink-0 text-xs">
							{labels.formatWhen(event.at, null)}
						</span>
					</div>
				</Item>
			))}
		</ItemGroup>
	)
}
