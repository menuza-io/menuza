import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { FieldLegend, FieldSet } from '@repo/ui/field'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { TextAreaField, TextField } from '#app/components/staff/controls.tsx'
import { useProfileContext } from '#app/components/staff/profile-context.ts'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient } from '#app/hooks/use-staff-client.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import {
	staffDisplayName,
	todayLocalDate,
} from '#app/utils/staffing/staff-format.ts'
import { staffResultSchema } from '#app/utils/staffing/staff-types.ts'
import { type Route } from './+types/team_.$staffId.terminate.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, STAFF_WRITE_REQUIREMENT)
	return null
}

type Step = 'details' | 'confirm'

/**
 * Terminating is deliberate: a form for the reason, last day and rehire
 * eligibility, then a separate confirm step. Only the final button is
 * destructive. Nothing is sent before it.
 */
export default function TerminateStaffRoute() {
	const { _, i18n } = useLingui()
	const { staff, onChanged, close } = useProfileContext()
	const { client } = useStaffClient('staff')
	const action = useStaffAction()
	const name = staffDisplayName(staff, i18n.locale)

	const [step, setStep] = useState<Step>('details')
	const [reason, setReason] = useState('')
	const [effectiveDate, setEffectiveDate] = useState(todayLocalDate())
	const [eligible, setEligible] = useState<'yes' | 'no'>('yes')
	const [errors, setErrors] = useState<{ reason?: string; date?: string }>({})
	// "2026-10-11" reads as a form value; the confirm step shows a real date.
	const [year, month, day] = effectiveDate.split('-').map(Number)
	const lastDayLabel =
		year && month && day
			? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long' }).format(
					new Date(year, month - 1, day),
				)
			: effectiveDate

	function next(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found: typeof errors = {}
		if (!reason.trim()) found.reason = _(t`Add a reason.`)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
			found.date = _(t`Choose the last day.`)
		}
		setErrors(found)
		if (Object.keys(found).length === 0) setStep('confirm')
	}

	async function confirm() {
		const result = await action.run(async () =>
			staffResultSchema.parse(
				await client.request(`/${staff.id}/terminate`, {
					method: 'POST',
					json: {
						reason: reason.trim(),
						effectiveDate,
						eligibleForRehire: eligible === 'yes',
					},
				}),
			),
		)
		if (result.ok) {
			toast.success(_(t`${name} has been terminated.`))
			onChanged()
			close()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) close()
			}}
		>
			<DialogContent>
				{step === 'details' ? (
					<form onSubmit={next} noValidate className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle>
								<Trans>Terminate {name}</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Tell us why and when. You confirm on the next step.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<TextAreaField
							label={<Trans>Reason</Trans>}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							error={errors.reason}
							rows={3}
							maxLength={500}
							autoFocus
						/>
						<TextField
							label={<Trans>Last day</Trans>}
							type="date"
							dir="ltr"
							value={effectiveDate}
							onChange={(event) => setEffectiveDate(event.target.value)}
							error={errors.date}
						/>
						<FieldSet>
							<FieldLegend variant="label">
								<Trans>Eligible for rehire?</Trans>
							</FieldLegend>
							<RadioGroup
								value={eligible}
								onValueChange={(value) => setEligible(value as 'yes' | 'no')}
								className="gap-1"
							>
								<Label className="flex min-h-11 items-center gap-3 text-sm">
									<RadioGroupItem value="yes" />
									<Trans>Yes</Trans>
								</Label>
								<Label className="flex min-h-11 items-center gap-3 text-sm">
									<RadioGroupItem value="no" />
									<Trans>No</Trans>
								</Label>
							</RadioGroup>
						</FieldSet>
						<DialogFooter>
							<Button type="button" variant="outline" onClick={close}>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit">
								<Trans>Continue</Trans>
							</Button>
						</DialogFooter>
					</form>
				) : (
					<div className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle>
								<Trans>Terminate {name}?</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Their PINs stop working now and their positions end on the
									last day. You can rehire them later.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted-foreground">
								<Trans>Last day</Trans>
							</dt>
							<dd>{lastDayLabel}</dd>
							<dt className="text-muted-foreground">
								<Trans>Reason</Trans>
							</dt>
							<dd>{reason.trim()}</dd>
							<dt className="text-muted-foreground">
								<Trans>Rehire</Trans>
							</dt>
							<dd>
								{eligible === 'yes' ? (
									<Trans>Eligible</Trans>
								) : (
									<Trans>Not eligible</Trans>
								)}
							</dd>
						</dl>
						{action.error ? (
							<Alert variant="destructive">
								<AlertDescription>{action.error}</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={action.pending}
								onClick={() => setStep('details')}
							>
								<Trans>Back</Trans>
							</Button>
							<Button
								type="button"
								variant="destructive"
								disabled={action.pending}
								onClick={() => void confirm()}
							>
								{action.pending ? (
									<Trans>Terminating…</Trans>
								) : (
									<Trans>Terminate {name}</Trans>
								)}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
