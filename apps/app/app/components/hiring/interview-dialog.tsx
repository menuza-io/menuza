import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type InterviewMode } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useState, type FormEvent } from 'react'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import {
	scheduleInterview,
	updateInterview,
} from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import {
	type ApplicantInterview,
	type ApplicantScope,
} from '#app/utils/hiring/applicant-types.ts'
import {
	interviewFields,
	interviewInstant,
} from '#app/utils/hiring/applicant-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { useApplicantLabels } from './applicant-labels.ts'

const DURATIONS = [15, 30, 45, 60, 90]

/**
 * Book or change an interview. The time is typed in the interview workplace's own
 * time zone (named under the field), never the manager's, because that is the
 * time the applicant is told. Saving can email the invitation in the same step;
 * if the applicant has no email the dialog says so and the manager phones them.
 */
export function InterviewDialog({
	client,
	applicationId,
	applicantScopeId,
	hasEmail,
	scopes,
	interview,
	onSaved,
	onClose,
}: {
	client: StaffClient
	applicationId: string
	/** The applicant's workplace; `null` when they have none yet. */
	applicantScopeId: string | null
	hasEmail: boolean
	scopes: ApplicantScope[]
	/** Present when changing an existing interview. */
	interview?: ApplicantInterview
	onSaved: () => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const labels = useApplicantLabels()
	const action = useStaffAction(describeApplicantError)
	const editing = interview !== undefined

	const [scopeId, setScopeId] = useState(
		interview?.scopeId ??
			applicantScopeId ??
			(scopes.length === 1 ? scopes[0]!.id : ''),
	)
	const zone = scopes.find((scope) => scope.id === scopeId)?.timeZone ?? null
	const initial = interview
		? interviewFields(interview.scheduledAt, zone ?? 'UTC')
		: {
				date: zone ? interviewFields(Date.now() + 86_400_000, zone).date : '',
				time: '10:00',
			}
	const [date, setDate] = useState(initial.date)
	const [time, setTime] = useState(initial.time)
	const [duration, setDuration] = useState(
		String(interview?.durationMinutes ?? 30),
	)
	const [mode, setMode] = useState<InterviewMode>(
		interview?.mode ?? 'in_person',
	)
	const [details, setDetails] = useState(interview?.details ?? '')
	const [send, setSend] = useState(hasEmail)
	const [problem, setProblem] = useState<string | null>(null)
	const placeName = scopes.find((scope) => scope.id === scopeId)?.name ?? ''

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (action.pending) return
		if (!zone) {
			setProblem(_(t`Choose where the interview takes place.`))
			return
		}
		const at = interviewInstant(date, time, zone)
		if (at === null) {
			setProblem(_(t`Enter a date and a time.`))
			return
		}
		if (at < Date.now() - 5 * 60_000) {
			setProblem(_(t`Pick a time that has not passed yet.`))
			return
		}
		setProblem(null)
		const result = await action.run(() =>
			editing
				? updateInterview(client, applicationId, interview.id, {
						scheduledAt: at,
						durationMinutes: Number(duration),
						mode,
						details: details.trim() || null,
						resendInvite: send && hasEmail,
					})
				: scheduleInterview(client, applicationId, {
						scheduledAt: at,
						durationMinutes: Number(duration),
						mode,
						details: details.trim() || undefined,
						...(applicantScopeId === null ? { scopeId } : {}),
						sendInvite: send && hasEmail,
					}),
		)
		if (result.ok) {
			onSaved()
			onClose()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="grid gap-4"
				>
					<DialogHeader>
						<DialogTitle>
							{editing ? (
								<Trans>Change interview</Trans>
							) : (
								<Trans>Schedule an interview</Trans>
							)}
						</DialogTitle>
						<DialogDescription>
							<Trans>
								The applicant is told the time and details you enter here.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					{applicantScopeId === null && !editing && scopes.length > 1 ? (
						<SelectField
							label={<Trans>Where</Trans>}
							value={scopeId}
							onValueChange={(next) => {
								setScopeId(next)
								setProblem(null)
							}}
							placeholder={_(t`Choose a workplace`)}
							options={scopes.map((scope) => ({
								value: scope.id,
								label: scope.name,
							}))}
							error={action.issues.scopeId}
						/>
					) : null}

					<div className="grid grid-cols-2 gap-3">
						<TextField
							label={<Trans>Date</Trans>}
							type="date"
							value={date}
							onChange={(event) => {
								setDate(event.target.value)
								setProblem(null)
							}}
							error={action.issues.scheduledAt}
							autoFocus
						/>
						<TextField
							label={<Trans>Time</Trans>}
							type="time"
							value={time}
							onChange={(event) => {
								setTime(event.target.value)
								setProblem(null)
							}}
						/>
					</div>
					{zone ? (
						<p className="text-muted-foreground -mt-2 text-sm">
							<Trans>
								Time at {placeName} ({zone}).
							</Trans>
						</p>
					) : null}

					<div className="grid grid-cols-2 gap-3">
						<SelectField
							label={<Trans>Length</Trans>}
							value={duration}
							onValueChange={setDuration}
							options={DURATIONS.map((minutes) => ({
								value: String(minutes),
								label: _(t`${minutes} minutes`),
							}))}
						/>
						<SelectField
							label={<Trans>How</Trans>}
							value={mode}
							onValueChange={(next) => setMode(next as InterviewMode)}
							options={labels.modeOptions}
						/>
					</div>

					<TextAreaField
						label={<Trans>Details for the applicant</Trans>}
						optional
						value={details}
						onChange={(event) => setDetails(event.target.value)}
						maxLength={500}
						rows={3}
						hint={_(
							t`Where to go, who to ask for, or the call-in details or meeting link.`,
						)}
						error={action.issues.details}
					/>

					<SwitchField
						label={
							editing ? (
								<Trans>Email the updated time</Trans>
							) : (
								<Trans>Email the invitation</Trans>
							)
						}
						description={
							hasEmail ? (
								<Trans>They get the time, length and details above.</Trans>
							) : (
								<Trans>
									There is no email on file for this applicant, so call them
									with the details.
								</Trans>
							)
						}
						checked={send && hasEmail}
						onCheckedChange={setSend}
						disabled={!hasEmail}
					/>

					{problem || action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{problem ?? action.error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={action.pending}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={action.pending}>
							{action.pending ? (
								<Trans>Saving…</Trans>
							) : editing ? (
								<Trans>Save changes</Trans>
							) : (
								<Trans>Schedule</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
