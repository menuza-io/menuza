import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type HiringOpenStage } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { SelectField } from '#app/components/staff/controls.tsx'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import { StaffAvatar } from '#app/components/staff/staff-avatar.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { moveApplicant } from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import {
	applicantDetailSchema,
	type ApplicantInterview,
	type DeclineResult,
} from '#app/utils/hiring/applicant-types.ts'
import {
	applicantName,
	BOARD_STAGES,
	isOpenStage,
} from '#app/utils/hiring/applicant-view.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { FitLabel, FlagNote } from './applicant-bits.tsx'
import { useApplicantsContext } from './applicant-context.ts'
import { useApplicantLabels } from './applicant-labels.ts'
import {
	AnswersList,
	ContactFacts,
	Fact,
	InterviewList,
	NotesPanel,
	Timeline,
} from './candidate-parts.tsx'
import { DeclineDialog } from './decline-dialog.tsx'
import { EraseDialog } from './erase-dialog.tsx'
import { HireDialog } from './hire-dialog.tsx'
import { InterviewDialog } from './interview-dialog.tsx'

type Dialog =
	| { kind: 'interview'; interview?: ApplicantInterview }
	| { kind: 'decline' }
	| { kind: 'hire' }
	| { kind: 'erase' }

/**
 * One candidate, in the side sheet. The primary job of this sheet is the next
 * step: move them, book an interview, hire or decline. Everything else (their
 * answers, notes, interviews and history) sits in tabs below. The details are
 * fetched browser-direct when the sheet opens; reading them is recorded in the
 * audit log.
 */
export function CandidateSheet({ applicationId }: { applicationId: string }) {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const labels = useApplicantLabels()
	const ctx = useApplicantsContext()
	const { client, ready } = useStaffClient('hiring')
	const query = useStaffQuery(
		client,
		ready ? `/applications/${encodeURIComponent(applicationId)}` : null,
		applicantDetailSchema,
	)
	const action = useStaffAction(describeApplicantError)
	const [dialog, setDialog] = useState<Dialog | null>(null)
	const detail = query.data

	const changed = () => {
		query.reload()
		ctx.reload()
	}

	if (query.error && !detail) {
		const notFound = 'status' in query.error && query.error.status === 404
		return (
			<SheetPanel
				title={
					notFound
						? _(t`We could not find that applicant`)
						: _(t`Could not load`)
				}
			>
				<Alert>
					<AlertDescription>
						{notFound
							? _(
									t`They may have been removed, or you may not have access to them.`,
								)
							: describeStaffError(query.error, _)}
					</AlertDescription>
				</Alert>
				<div className="flex gap-3">
					<Button
						variant="outline"
						render={<Link to={`${ctx.basePath}${ctx.search}`} />}
					>
						<Trans>Back to applicants</Trans>
					</Button>
					{!notFound ? (
						<Button onClick={query.reload}>
							<Trans>Try again</Trans>
						</Button>
					) : null}
				</div>
			</SheetPanel>
		)
	}

	if (!detail) {
		return (
			<SheetPanel
				title={
					<>
						<Skeleton className="h-5 w-40" />
						<span className="sr-only">
							<Trans>Loading applicant</Trans>
						</span>
					</>
				}
			>
				<div aria-hidden="true" className="flex flex-col gap-4">
					<Skeleton className="h-9 w-full" />
					<Skeleton className="h-9 w-full" />
					<Skeleton className="h-9 w-2/3" />
				</div>
			</SheetPanel>
		)
	}

	const name = applicantName(detail)
	const stage = detail.stage
	const open = isOpenStage(stage)
	// Everywhere the person would work, the main scope first. With one scope
	// there is nothing to tell apart, so no name is shown.
	const placeIds = [
		...new Set(
			[detail.scopeId, ...detail.interestedScopeIds].filter(
				(id): id is string => Boolean(id),
			),
		),
	]
	const place =
		ctx.scopes.length > 1
			? placeIds
					.flatMap((id) => ctx.scopes.find((s) => s.id === id)?.name ?? [])
					.join(', ') || null
			: null
	const timeZoneOf = (scopeId: string | null) =>
		(scopeId ? ctx.scopes.find((s) => s.id === scopeId)?.timeZone : null) ??
		null
	const upcoming = detail.interviews.filter((i) => i.status === 'scheduled')
	const hasEmail = detail.email !== null

	async function moveTo(next: HiringOpenStage) {
		const result = await action.run(() =>
			moveApplicant(client, applicationId, next),
		)
		if (result.ok) changed()
	}

	function declined(result: DeclineResult) {
		changed()
		const message =
			result.email === 'sent'
				? _(t`Declined. They were sent your message.`)
				: result.email === 'failed'
					? _(t`Declined, but the message could not be sent.`)
					: result.email === 'no_email'
						? _(t`Declined. There is no email on file, so nothing was sent.`)
						: result.email === 'email_disabled'
							? _(t`Declined. Email is turned off, so nothing was sent.`)
							: _(t`Declined.`)
		if (result.email === 'failed') toast.warning(message)
		else toast.success(message)
	}

	const retentionDate = detail.retentionExpiresAt
		? labels.formatDay(detail.retentionExpiresAt)
		: null
	const hiredOn = detail.hiredAt ? labels.formatDay(detail.hiredAt) : null
	const declineReasonLabel = detail.declinedReason
		? labels.declineReason[detail.declinedReason]
		: null
	const consentOn = labels.formatDay(detail.consentAt)
	const consentVersion = detail.consentVersion
	const keepDays = detail.declineRetentionDays

	return (
		<>
			<SheetPanel
				title={
					<span className="flex items-center gap-3">
						<StaffAvatar name={name} />
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="truncate text-base font-medium">{name}</span>
							<span className="text-muted-foreground truncate text-sm font-normal">
								{[detail.postingTitle, place].filter(Boolean).join(' · ')}
							</span>
						</span>
					</span>
				}
				headerExtra={
					ctx.canWrite ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={_(t`More actions for ${name}`)}
									>
										<Icon name="ellipsis" />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => setDialog({ kind: 'erase' })}>
									<Icon name="trash-2" />
									<Trans>Delete application…</Trans>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null
				}
			>
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<span className="text-sm font-medium">{labels.stage[stage]}</span>
						<FitLabel score={detail.screenerScore} labels={labels} />
						<FlagNote count={detail.flags.length} />
					</div>

					{ctx.canWrite && open ? (
						<>
							<SelectField
								label={<Trans>Stage</Trans>}
								value={stage}
								onValueChange={(next) => void moveTo(next as HiringOpenStage)}
								options={labels.stageOptions(BOARD_STAGES)}
								disabled={action.pending}
							/>
							<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
								<Button
									className="col-span-2 h-11 sm:col-span-1 md:h-8"
									onClick={() => setDialog({ kind: 'hire' })}
								>
									<Icon name="user-plus" />
									<Trans>Hire</Trans>
								</Button>
								<Button
									variant="outline"
									onClick={() => setDialog({ kind: 'interview' })}
								>
									<Icon name="calendar" />
									<Trans>Interview</Trans>
								</Button>
								<Button
									variant="outline"
									onClick={() => setDialog({ kind: 'decline' })}
								>
									<Trans>Decline</Trans>
								</Button>
							</div>
						</>
					) : null}

					{stage === 'hired' ? (
						<div className="flex flex-col items-start gap-2" role="status">
							<p className="text-sm">
								{hiredOn ? (
									<Trans>Hired on {hiredOn}.</Trans>
								) : (
									<Trans>Hired.</Trans>
								)}
							</p>
							{detail.hiredStaffId ? (
								<Button
									variant="outline"
									render={
										<Link
											to={`/${ctx.orgSlug}/staff/team/${detail.hiredStaffId}`}
										/>
									}
								>
									<Trans>Open profile</Trans>
								</Button>
							) : null}
						</div>
					) : null}

					{stage === 'declined' ? (
						<div className="flex flex-col items-start gap-2" role="status">
							<p className="text-sm">
								{declineReasonLabel ? (
									<Trans>Declined: {declineReasonLabel}.</Trans>
								) : (
									<Trans>Declined.</Trans>
								)}
							</p>
							{retentionDate ? (
								<p className="text-muted-foreground text-sm">
									<Trans>Their details are removed on {retentionDate}.</Trans>
								</p>
							) : null}
							{ctx.canWrite ? (
								<Button
									variant="outline"
									disabled={action.pending}
									onClick={() => void moveTo('new')}
								>
									<Icon name="undo-2" />
									<Trans>Move back into the pipeline</Trans>
								</Button>
							) : null}
						</div>
					) : null}

					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
				</div>

				<Tabs defaultValue="details" className="gap-4">
					<TabsList className="w-full justify-start">
						<TabsTrigger
							value="details"
							className="min-h-11 flex-none md:min-h-0"
						>
							<Trans>Details</Trans>
						</TabsTrigger>
						<TabsTrigger
							value="interviews"
							className="min-h-11 flex-none md:min-h-0"
						>
							<Trans>Interviews</Trans>
							{detail.interviews.length > 0 ? (
								<span className="text-muted-foreground text-xs tabular-nums">
									{detail.interviews.length}
								</span>
							) : null}
						</TabsTrigger>
						<TabsTrigger
							value="notes"
							className="min-h-11 flex-none md:min-h-0"
						>
							<Trans>Notes</Trans>
							{detail.notes.length > 0 ? (
								<span className="text-muted-foreground text-xs tabular-nums">
									{detail.notes.length}
								</span>
							) : null}
						</TabsTrigger>
						<TabsTrigger
							value="history"
							className="min-h-11 flex-none md:min-h-0"
						>
							<Trans>History</Trans>
						</TabsTrigger>
					</TabsList>

					<TabsContent value="details" className="flex flex-col gap-6">
						<section
							aria-labelledby="contact-heading"
							className="flex flex-col gap-1"
						>
							<h3 id="contact-heading" className="text-sm font-medium">
								<Trans>Contact</Trans>
							</h3>
							<ContactFacts detail={detail} />
							<dl>
								<Fact label={_(t`Applied`)}>
									{labels.formatDay(detail.createdAt)}
									{' · '}
									{labels.source[detail.source]}
								</Fact>
								<Fact label={_(t`Language`)}>
									{detail.locale === 'ar' ? _(t`Arabic`) : _(t`English`)}
								</Fact>
							</dl>
						</section>
						<section
							aria-labelledby="answers-heading"
							className="flex flex-col gap-1"
						>
							<h3 id="answers-heading" className="text-sm font-medium">
								<Trans>Their answers</Trans>
							</h3>
							<AnswersList answers={detail.answers} />
						</section>
						<section
							aria-labelledby="privacy-heading"
							className="flex flex-col gap-1"
						>
							<h3 id="privacy-heading" className="text-sm font-medium">
								<Trans>Privacy</Trans>
							</h3>
							<p className="text-muted-foreground text-sm text-pretty">
								<Trans>
									They agreed to your privacy notice (version {consentVersion})
									on {consentOn}. Declined applicants are removed after{' '}
									{keepDays} days.
								</Trans>
							</p>
						</section>
					</TabsContent>

					<TabsContent value="interviews" className="flex flex-col gap-4">
						<InterviewList
							client={client}
							applicationId={applicationId}
							interviews={detail.interviews}
							labels={labels}
							timeZoneOf={timeZoneOf}
							canWrite={ctx.canWrite}
							onEdit={(interview) =>
								setDialog({ kind: 'interview', interview })
							}
							onChanged={changed}
						/>
						{ctx.canWrite && open ? (
							<Button
								variant="outline"
								className="h-11 self-start md:h-8"
								onClick={() => setDialog({ kind: 'interview' })}
							>
								<Icon name="plus" />
								{upcoming.length > 0 ? (
									<Trans>Schedule another</Trans>
								) : (
									<Trans>Schedule an interview</Trans>
								)}
							</Button>
						) : null}
					</TabsContent>

					<TabsContent value="notes">
						<NotesPanel
							client={client}
							applicationId={applicationId}
							notes={detail.notes}
							userId={ctx.userId}
							canWrite={ctx.canWrite}
							labels={labels}
							onChanged={changed}
						/>
					</TabsContent>

					<TabsContent value="history">
						<Timeline events={detail.timeline} labels={labels} />
					</TabsContent>
				</Tabs>
			</SheetPanel>

			{dialog?.kind === 'interview' ? (
				<InterviewDialog
					client={client}
					applicationId={applicationId}
					applicantScopeId={detail.scopeId}
					hasEmail={hasEmail}
					scopes={ctx.scopes}
					interview={dialog.interview}
					onSaved={changed}
					onClose={() => setDialog(null)}
				/>
			) : null}
			{dialog?.kind === 'decline' ? (
				<DeclineDialog
					client={client}
					applicationId={applicationId}
					name={name}
					hasEmail={hasEmail}
					retentionDays={detail.declineRetentionDays}
					onDeclined={declined}
					onClose={() => setDialog(null)}
				/>
			) : null}
			{dialog?.kind === 'hire' ? (
				<HireDialog
					client={client}
					orgSlug={ctx.orgSlug}
					applicationId={applicationId}
					name={name}
					applicantScopeId={detail.scopeId}
					scopes={ctx.scopes}
					canInvite={ctx.canInvite}
					onHired={changed}
					onClose={() => setDialog(null)}
				/>
			) : null}
			{dialog?.kind === 'erase' ? (
				<EraseDialog
					client={client}
					applicationId={applicationId}
					name={name}
					wasHired={detail.hiredStaffId !== null}
					onErased={() => {
						ctx.reload()
						toast.success(_(t`Application deleted.`))
						void navigate(`${ctx.basePath}${ctx.search}`)
					}}
					onClose={() => setDialog(null)}
				/>
			) : null}
		</>
	)
}
