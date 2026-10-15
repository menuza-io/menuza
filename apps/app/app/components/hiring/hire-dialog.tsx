import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { WORKER_TYPES, type WorkerType } from '@repo/staffing'
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
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { hireApplicant } from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import {
	hirePositionsSchema,
	type ApplicantScope,
	type HireResult,
} from '#app/utils/hiring/applicant-types.ts'
import { interviewFields } from '#app/utils/hiring/applicant-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'

/**
 * The hire. One step: where they will work, in what position and from when. It
 * creates the team member, their workplace, their position and the new-hire
 * checklist together, or nothing at all. Pay is set afterwards on their profile,
 * where pay access is checked. When it works the dialog turns into a short
 * "welcome" step with the next things a manager usually does: open the profile
 * and, optionally, invite them to the app.
 */
export function HireDialog({
	client,
	orgSlug,
	applicationId,
	name,
	applicantScopeId,
	scopes,
	canInvite,
	onHired,
	onClose,
}: {
	client: StaffClient
	orgSlug: string
	applicationId: string
	name: string
	applicantScopeId: string | null
	scopes: ApplicantScope[]
	canInvite: boolean
	onHired: () => void
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	const action = useStaffAction(describeApplicantError)
	const positions = useStaffQuery(client, '/positions', hirePositionsSchema)
	const [scopeId, setScopeId] = useState(
		applicantScopeId ?? (scopes.length === 1 ? scopes[0]!.id : ''),
	)
	const scope = scopes.find((item) => item.id === scopeId) ?? null
	const [positionId, setPositionId] = useState('')
	const [date, setDate] = useState(
		() => interviewFields(Date.now(), scope?.timeZone ?? 'UTC').date,
	)
	const [workerType, setWorkerType] = useState<WorkerType>('employee')
	const [payrollId, setPayrollId] = useState('')
	const [checklist, setChecklist] = useState(true)
	const [problem, setProblem] = useState<string | null>(null)
	const [done, setDone] = useState<HireResult | null>(null)

	const options = positions.data?.positions ?? []
	const noPositions = positions.data !== null && options.length === 0
	// With one position there is nothing to choose.
	const onlyPosition = options.length === 1 ? options[0]!.id : null
	useEffect(() => {
		if (onlyPosition) setPositionId((current) => current || onlyPosition)
	}, [onlyPosition])

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (action.pending) return
		if (!scope) {
			setProblem(_(t`Choose where they will work.`))
			return
		}
		if (!positionId) {
			setProblem(_(t`Choose a position.`))
			return
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			setProblem(_(t`Enter their first day.`))
			return
		}
		setProblem(null)
		const result = await action.run(() =>
			hireApplicant(client, applicationId, {
				scopeId: scope.id,
				positionId,
				hiredDate: date,
				workerType,
				employeeNumber: payrollId.trim() || undefined,
				payType: 'hourly',
				rateMinor: null,
				annualSalaryMinor: null,
				currency: scope.currency,
				overtimeExempt: false,
				tipEligible: false,
				startOnboarding: checklist,
			}),
		)
		if (result.ok) {
			setDone(result.value)
			onHired()
		}
	}

	if (done) {
		return (
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) onClose()
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>{name} is on your team</Trans>
						</DialogTitle>
						<DialogDescription>
							{done.onboardingTasks > 0
								? plural(done.onboardingTasks, {
										one: 'We added a new-hire checklist with # task.',
										other: 'We added a new-hire checklist with # tasks.',
									})
								: _(t`They are on the roster.`)}{' '}
							<Trans>Set their pay on their profile.</Trans>
						</DialogDescription>
					</DialogHeader>
					{canInvite && done.inviteEmail ? (
						<InviteToApp
							orgSlug={orgSlug}
							staffId={done.staffId}
							email={done.inviteEmail}
						/>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							<Trans>Done</Trans>
						</Button>
						<Button
							render={<Link to={`/${orgSlug}/staff/team/${done.staffId}`} />}
						>
							<Trans>Open profile</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		)
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
							<Trans>Hire {name}</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								This adds them to your team with their contact details. You can
								change anything on their profile afterwards.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					{applicantScopeId === null && scopes.length > 1 ? (
						<SelectField
							label={<Trans>Workplace</Trans>}
							value={scopeId}
							onValueChange={(next) => {
								setScopeId(next)
								setProblem(null)
							}}
							placeholder={_(t`Choose a workplace`)}
							options={scopes.map((item) => ({
								value: item.id,
								label: item.name,
							}))}
							error={action.issues.scopeId}
						/>
					) : null}

					{noPositions ? (
						<p className="text-sm" role="status">
							<Trans>
								You have not set up any positions yet.{' '}
								<Link
									to={`/${orgSlug}/staff/positions`}
									className="underline underline-offset-4"
								>
									Add a position
								</Link>{' '}
								first, then come back to hire.
							</Trans>
						</p>
					) : (
						<SelectField
							label={<Trans>Position</Trans>}
							value={positionId}
							onValueChange={(next) => {
								setPositionId(next)
								setProblem(null)
							}}
							placeholder={
								positions.loading ? _(t`Loading…`) : _(t`Choose a position`)
							}
							options={options.map((item) => ({
								value: item.id,
								label:
									(i18n.locale.startsWith('ar') && item.nameAr) ||
									pickLocalized(item.name, i18n.locale, 'en') ||
									item.name,
							}))}
							disabled={positions.loading}
							error={action.issues.positionId}
						/>
					)}
					{positions.error ? (
						<Alert variant="destructive">
							<AlertDescription>
								<Trans>
									We could not load your positions. Close this and try again.
								</Trans>
							</AlertDescription>
						</Alert>
					) : null}

					<div className="grid grid-cols-2 gap-3">
						<TextField
							label={<Trans>First day</Trans>}
							type="date"
							value={date}
							onChange={(event) => {
								setDate(event.target.value)
								setProblem(null)
							}}
							error={action.issues.hiredDate}
						/>
						<SelectField
							label={<Trans>Works as</Trans>}
							value={workerType}
							onValueChange={(next) => setWorkerType(next as WorkerType)}
							options={WORKER_TYPES.map((value) => ({
								value,
								label: value === 'employee' ? _(t`Employee`) : _(t`Contractor`),
							}))}
						/>
					</div>

					<TextField
						label={<Trans>Payroll ID</Trans>}
						optional
						value={payrollId}
						onChange={(event) => setPayrollId(event.target.value)}
						maxLength={40}
						error={action.issues.employeeNumber}
					/>

					<SwitchField
						label={<Trans>Start the new-hire checklist</Trans>}
						description={
							<Trans>
								A short list of first-week tasks, like confirming contact
								details and setting up their clock-in PIN.
							</Trans>
						}
						checked={checklist}
						onCheckedChange={setChecklist}
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
						<Button type="submit" disabled={action.pending || noPositions}>
							{action.pending ? <Trans>Hiring…</Trans> : <Trans>Hire</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

/**
 * Optional: email the new hire a link to create an app login. The same route and
 * the same disclosure as the profile's Access tab; the only thing that leaves the
 * browser for the control plane is the email address the applicant gave and the
 * opaque staff id.
 */
function InviteToApp({
	orgSlug,
	staffId,
	email,
}: {
	orgSlug: string
	staffId: string
	email: string
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok?: true; error?: string }>()
	const pending = fetcher.state !== 'idle'
	const sent = fetcher.data?.ok === true
	useEffect(() => {
		if (fetcher.data?.ok) toast.success(_(t`Invitation sent.`))
	}, [fetcher.data, _])

	return (
		<div className="border-border flex flex-col gap-2 rounded-lg border p-3">
			<p className="text-sm font-medium">
				<Trans>Invite them to the app?</Trans>
			</p>
			<p className="text-muted-foreground text-sm">
				<Trans>
					We will email {email} a link to create a login. They join as a member,
					without access to staff or pay data. This is optional; they can clock
					in with a PIN either way.
				</Trans>
			</p>
			{fetcher.data?.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						{fetcher.data.error === 'region_not_supported'
							? _(t`Invitations are not available for this organization.`)
							: _(t`The invitation was not sent. Try again.`)}
					</AlertDescription>
				</Alert>
			) : null}
			<Button
				type="button"
				variant="outline"
				className="h-11 self-start md:h-8"
				disabled={pending || sent}
				onClick={() =>
					void fetcher.submit(
						{ email, staffId },
						{ method: 'post', action: `/${orgSlug}/staff/invite` },
					)
				}
			>
				{sent ? (
					<Trans>Invitation sent</Trans>
				) : pending ? (
					<Trans>Sending…</Trans>
				) : (
					<Trans>Send invitation</Trans>
				)}
			</Button>
		</div>
	)
}
